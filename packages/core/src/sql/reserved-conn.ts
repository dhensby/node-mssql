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
 * which any further query throws `StateError`. `release()` is
 * idempotent. `Symbol.asyncDispose` calls `release()`.
 */

import type { Connection, ExecuteRequest, IsolationLevel, ResultEvent } from '../driver/index.js';
import { StateError } from '../errors/index.js';
import type { PooledConnection } from '../pool/index.js';
import type { Query, RequestRunner } from '../query/index.js';
import { withResolvers } from '../util/index.js';
import { makeSqlTag, type SqlTag, type UnsafeParams } from './tag.js';
import {
	DEFAULT_ISOLATION_LEVEL,
	makeReservedTransactionBuilder,
	type SqlTransactionBuilder,
} from './transaction.js';

const RELEASED =
	'ReservedConn has been released. Calling a tag on a released connection is not allowed.';

const SIGNAL_AFTER_START =
	'signal() called on an in-flight or settled acquire — set the signal before awaiting the builder.';

/**
 * A connection pinned for the lifetime of an `await using` (or until
 * an explicit `.release()`). Inherits the base {@link SqlTag} surface
 * (callable + `.unsafe`), adds `.transaction()` (a transaction on the
 * held connection), and release-related lifecycle.
 *
 * Does NOT carry `.acquire` — nested acquires on a pinned connection
 * make no sense (the connection is already pinned). Compare with
 * {@link PoolBoundSqlTag} which adds `.acquire` to the base.
 */
export interface ReservedConn extends SqlTag, AsyncDisposable {
	/**
	 * Open a transaction on the reserved connection. Same
	 * {@link SqlTransactionBuilder} shape as `sql.transaction()`; the
	 * transaction runs on the connection this `ReservedConn` holds and
	 * does not return it to the pool on commit/rollback (the
	 * `ReservedConn` owns the connection — release it yourself).
	 */
	transaction(): SqlTransactionBuilder
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
	defaultIsolationLevel: IsolationLevel = DEFAULT_ISOLATION_LEVEL,
): SqlAcquireBuilder {
	let abortSignal: AbortSignal | undefined;
	let started: Promise<ReservedConn> | undefined;

	const start = (): Promise<ReservedConn> => {
		if (started !== undefined) return started;
		started = (async () => {
			const pooled = await acquire(abortSignal);
			return makeReservedConn(pooled, defaultIsolationLevel);
		})();
		return started;
	};

	const builder: SqlAcquireBuilder = {
		signal(s) {
			if (started !== undefined) {
				throw new StateError(SIGNAL_AFTER_START);
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
export function makeReservedConn(
	pooled: PooledConnection,
	defaultIsolationLevel: IsolationLevel = DEFAULT_ISOLATION_LEVEL,
): ReservedConn {
	let released = false;
	const pinned = pinnedConnection(pooled.connection);
	const baseTag = makeSqlTag(pinned.runner);

	function callable<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		if (released) throw new StateError(RELEASED);
		return baseTag<T>(strings, ...values);
	}

	const conn = callable as ReservedConn;
	conn.unsafe = function unsafe<T = unknown>(
		text: string,
		params?: UnsafeParams,
	): Query<T> {
		if (released) throw new StateError(RELEASED);
		return baseTag.unsafe<T>(text, params);
	};
	conn.transaction = function transaction(): SqlTransactionBuilder {
		if (released) throw new StateError(RELEASED);
		// Share the reserved connection AND its FIFO queue (tag + exclusive)
		// so transaction queries and control ops serialise with bare
		// reserved-connection queries on the one queue; the transaction's
		// settle does not release the connection (the ReservedConn owns it).
		return makeReservedTransactionBuilder(
			pooled.connection,
			baseTag,
			pinned.exclusive,
			defaultIsolationLevel,
		);
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
 * A single pinned {@link Connection} with FIFO-serialised access. TDS
 * serves only one in-flight request per connection, so *every* operation
 * shares one queue: tag queries via {@link PinnedConnection.runner} and
 * transaction control ops (BEGIN / COMMIT / ROLLBACK / SAVE / ROLLBACK TO)
 * via {@link PinnedConnection.exclusive}. Each waits for the previous to
 * settle; none overlaps another.
 *
 * A failing operation does NOT poison the queue — the chain
 * `await prev.catch(swallow)` waits for settlement (success OR failure)
 * and lets the next proceed cleanly.
 */
export interface PinnedConnection {
	/** FIFO-serialised {@link RequestRunner} for tag queries. */
	readonly runner: RequestRunner
	/**
	 * Run a control op exclusively on the pinned connection — after every
	 * prior queued operation settles, blocking subsequent ones until it
	 * resolves. The transaction scope routes its wire control ops through
	 * here so a `COMMIT` / `SAVE` / `ROLLBACK` never overlaps a query or
	 * one another.
	 */
	exclusive<T>(op: () => Promise<T>): Promise<T>
}

/**
 * Build a {@link PinnedConnection} over one {@link Connection}. Exported
 * (rather than file-private) so the transaction / savepoint scopes — which
 * also pin one connection for their duration — share the same FIFO queue
 * rather than re-implementing it.
 */
export function pinnedConnection(connection: Connection): PinnedConnection {
	let lastSettled: Promise<void> = Promise.resolve();
	const swallow = (): void => { /* deliberate: prior errors don't poison the queue */ };

	// Reserve the next slot in the FIFO chain: capture the predecessor to
	// await, publish a fresh barrier for the successor, and return the `done`
	// that releases it. Shared by `runner.run` (queries) and `exclusive`
	// (control ops) so both interleave on the one queue.
	const reserve = (): { prev: Promise<void>; done: () => void } => {
		const prev = lastSettled;
		const { promise, resolve } = withResolvers<void>();
		lastSettled = promise;
		return { prev, done: resolve };
	};

	return {
		runner: {
			run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
				const { prev, done } = reserve();
				return (async function* () {
					try {
						await prev.catch(swallow);
						for await (const ev of connection.execute(req, signal)) {
							yield ev;
						}
					} finally {
						done();
					}
				})();
			},
		},
		async exclusive<T>(op: () => Promise<T>): Promise<T> {
			const { prev, done } = reserve();
			try {
				await prev.catch(swallow);
				return await op();
			} finally {
				done();
			}
		},
	};
}
