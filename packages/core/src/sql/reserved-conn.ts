/**
 * `ReservedConn` and the `sql.acquire()` builder (ADR-0006).
 *
 * `sql.acquire()` returns a chainable {@link SqlAcquireBuilder} that —
 * on `await` — pins one connection from the pool for the lifetime of
 * the returned {@link ReservedConn}. The connection is held until the
 * caller releases it (explicitly via `.release()` or implicitly via
 * `await using`'s `Symbol.asyncDispose`); during that window every
 * query on the `ReservedConn` runs on the SAME underlying connection.
 *
 * Why a pinned scope exists — pool-bound queries (`sql\`...\``) aren't
 * guaranteed to land on the same connection across calls, so session-
 * scoped state (temp tables `#tmp`, `SET LANGUAGE`, `USE other_db`)
 * is unsafe across them. `sql.acquire()` is the explicit pin.
 *
 * Concurrency — the underlying TDS connection only serves one in-
 * flight request at a time. The {@link ReservedConn}'s pinned runner
 * serialises concurrent calls FIFO so `Promise.all([conn\`q1\`,
 * conn\`q2\`])` always works (per ADR-0006), the second query runs
 * immediately after the first settles. A failing query does NOT
 * poison the queue — the next one proceeds on the same connection.
 *
 * Lifecycle — `release()` returns the connection to the pool, after
 * which any further query throws `TypeError`. `release()` is
 * idempotent. `Symbol.asyncDispose` calls `release()`.
 */

import type { Connection, ExecuteRequest, ResultEvent } from '../driver/index.js';
import type { PooledConnection } from '../pool/index.js';
import type { Query, RequestRunner } from '../query/index.js';
import { makeSqlTag, type SqlTag, type UnsafeParams } from './tag.js';

const RELEASED =
	'ReservedConn has been released. Calling a tag on a released connection is not allowed (ADR-0008).';

const SIGNAL_AFTER_START =
	'signal() called on an in-flight or settled acquire — set the signal before awaiting the builder.';

/**
 * A connection pinned for the lifetime of an `await using` (or until
 * an explicit `.release()`). Inherits the base {@link SqlTag} surface
 * (callable + `.unsafe`) and adds release-related lifecycle.
 *
 * Does NOT carry `.acquire` — nested acquires on a pinned connection
 * make no sense (the connection is already pinned). Compare with
 * {@link PoolBoundSqlTag} which adds `.acquire` to the base.
 */
export interface ReservedConn extends SqlTag, AsyncDisposable {
	release(): Promise<void>
	readonly released: boolean
}

/**
 * Lazily-evaluated builder returned by `sql.acquire()`. Awaitable via
 * `then` (resolves to the `ReservedConn` after `pool.acquire()`
 * settles); chainable `.signal(s)` configures the abort signal that
 * propagates to the pool's acquire wait.
 *
 * `signal()` must be called BEFORE the builder is awaited — the
 * acquire fires on the first `then()` and configuration after that
 * is a logic error.
 */
export interface SqlAcquireBuilder extends PromiseLike<ReservedConn> {
	signal(signal: AbortSignal): SqlAcquireBuilder
}

/**
 * Build a {@link SqlAcquireBuilder} over a pool's `acquire` function.
 *
 * The acquire is lazy — `pool.acquire()` runs only on the first
 * `then()` (i.e. when the builder is awaited), so chained config
 * (`.signal()`) all applies before any wire work happens.
 */
export function makeAcquireBuilder(
	acquire: (signal?: AbortSignal) => Promise<PooledConnection>,
): SqlAcquireBuilder {
	let abortSignal: AbortSignal | undefined;
	let started: Promise<ReservedConn> | undefined;

	const start = (): Promise<ReservedConn> => {
		if (started !== undefined) return started;
		started = (async () => {
			const pooled = await acquire(abortSignal);
			return makeReservedConn(pooled);
		})();
		return started;
	};

	const builder: SqlAcquireBuilder = {
		signal(s) {
			if (started !== undefined) {
				throw new TypeError(SIGNAL_AFTER_START);
			}
			abortSignal = s;
			return builder;
		},
		then(onFulfilled, onRejected) {
			return start().then(onFulfilled, onRejected);
		},
	};
	return builder;
}

/**
 * Wrap a {@link PooledConnection} as a {@link ReservedConn}. Internal —
 * users get one of these via `sql.acquire()`.
 */
export function makeReservedConn(pooled: PooledConnection): ReservedConn {
	let released = false;
	const baseTag = makeSqlTag(pinnedRunner(pooled.connection));

	function callable<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		if (released) throw new TypeError(RELEASED);
		return baseTag<T>(strings, ...values);
	}

	const conn = callable as ReservedConn;
	conn.unsafe = function unsafe<T = unknown>(
		text: string,
		params?: UnsafeParams,
	): Query<T> {
		if (released) throw new TypeError(RELEASED);
		return baseTag.unsafe<T>(text, params);
	};
	conn.release = async function release(): Promise<void> {
		if (released) return;
		released = true;
		await pooled.release();
	};
	conn[Symbol.asyncDispose] = function dispose(): Promise<void> {
		return conn.release();
	};
	Object.defineProperty(conn, 'released', {
		get() { return released; },
	});
	return conn;
}

/**
 * `RequestRunner` for a single pinned {@link Connection}. FIFO-serialises
 * concurrent `run()` calls because TDS allows only one in-flight request
 * per connection.
 *
 * A failing previous request does NOT abort subsequent ones — the chain
 * `await prev.catch(swallow)` waits for settlement (success OR failure)
 * and lets the next call proceed cleanly.
 */
function pinnedRunner(connection: Connection): RequestRunner {
	let lastSettled: Promise<void> = Promise.resolve();
	const swallow = (): void => { /* deliberate: prior errors don't poison the queue */ };

	return {
		run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
			const prev = lastSettled;
			let resolveDone!: () => void;
			lastSettled = new Promise<void>((res) => { resolveDone = res; });

			return (async function* () {
				try {
					await prev.catch(swallow);
					for await (const ev of connection.execute(req, signal)) {
						yield ev;
					}
				} finally {
					resolveDone();
				}
			})();
		},
	};
}
