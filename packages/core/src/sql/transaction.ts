/**
 * `Transaction` and the `sql.transaction()` builder (ADR-0006).
 *
 * `sql.transaction()` returns a chainable {@link SqlTransactionBuilder}
 * that — on `await` — pins one connection from the pool and issues
 * `BEGIN TRANSACTION` (with the resolved isolation level) before
 * resolving to a {@link Transaction}. Tag execution on the returned
 * Transaction goes through the SAME pinned runner as `sql.acquire()`,
 * so concurrent queries serialise FIFO and `Promise.all` works.
 *
 * Lifecycle — explicit `.commit()` / `.rollback()` are the happy paths;
 * `Symbol.asyncDispose` rolls back if the user falls off the scope
 * without committing (per the ADR's `await using` model). Repeat calls
 * to either lifecycle method are idempotent: the SECOND call no-ops
 * rather than rejecting, matching `Pool.drain` / `Connection.close`
 * behaviour.
 *
 * Isolation level — resolved per ADR-0006: per-call `.isolationLevel()`
 * wins; the client-level default falls through next; `'read committed'`
 * is the library default. The kernel always passes a concrete level
 * through the driver port — there is no "no override" case at the
 * boundary.
 *
 * Savepoints (R-6 also) — `tx.savepoint()` returns a
 * {@link SqlSavepointBuilder}. The savepoint shares the parent tx's
 * pinned connection (and its base tag), so queries on the savepoint
 * also queue FIFO behind the parent's queue. Savepoints inherit the
 * outer transaction's isolation level (TDS protocol property — no
 * per-savepoint override).
 */

import type { IsolationLevel } from '../driver/index.js';
import type { PooledConnection } from '../pool/index.js';
import type { Query } from '../query/index.js';
import { makeSavepointBuilder, type SqlSavepointBuilder } from './savepoint.js';
import { pinnedRunner } from './reserved-conn.js';
import { makeSqlTag, type SqlTag, type UnsafeParams } from './tag.js';

const TX_NOT_OPEN = (state: TransactionState): string =>
	`Transaction is ${state}. Calling a tag or lifecycle method on a non-open transaction is not allowed (ADR-0008).`;

const SIGNAL_AFTER_START =
	'signal() called on an in-flight or settled transaction builder — set the signal before awaiting.';

const ISOLATION_AFTER_START =
	'isolationLevel() called on an in-flight or settled transaction builder — set the isolation level before awaiting.';

export type TransactionState = 'open' | 'committed' | 'rolled-back';

/**
 * The library's asserted default isolation level (ADR-0006). The
 * Transaction builder uses this when neither a per-call nor client-
 * level override applies.
 */
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = 'read committed';

/**
 * A pinned-connection scope with transaction lifecycle. Inherits the
 * base {@link SqlTag} surface (callable + `.unsafe`), adds explicit
 * `.commit()` / `.rollback()` and savepoint-creation, plus
 * `Symbol.asyncDispose` for `await using`.
 */
export interface Transaction extends SqlTag, AsyncDisposable {
	commit(): Promise<void>
	rollback(): Promise<void>
	savepoint(): SqlSavepointBuilder
	readonly state: TransactionState
}

/**
 * Lazy builder returned by `sql.transaction()` / `conn.transaction()`.
 * Awaitable for the {@link Transaction} (acquire + BEGIN); chainable
 * `.signal(s)` and `.isolationLevel(level)` configure the wait and
 * the BEGIN's level. Configuration must happen BEFORE the builder is
 * awaited — `.signal()` / `.isolationLevel()` after that throw.
 */
export interface SqlTransactionBuilder extends PromiseLike<Transaction> {
	signal(signal: AbortSignal): SqlTransactionBuilder
	isolationLevel(level: IsolationLevel): SqlTransactionBuilder
}

/**
 * Build a {@link SqlTransactionBuilder} that acquires a pinned
 * connection and issues BEGIN TRANSACTION on first `then()`.
 *
 * The `defaultLevel` is the client-level fallback (which itself falls
 * through to the library default `'read committed'`); per-call
 * `.isolationLevel()` overrides it.
 */
export function makeTransactionBuilder(
	acquire: (signal?: AbortSignal) => Promise<PooledConnection>,
	defaultLevel: IsolationLevel,
): SqlTransactionBuilder {
	let abortSignal: AbortSignal | undefined;
	let perCallLevel: IsolationLevel | undefined;
	let started: Promise<Transaction> | undefined;

	const start = (): Promise<Transaction> => {
		if (started !== undefined) return started;
		started = (async () => {
			const pooled = await acquire(abortSignal);
			try {
				const effectiveLevel = perCallLevel ?? defaultLevel;
				await pooled.connection.beginTransaction({
					isolationLevel: effectiveLevel,
				});
				return makeTransaction(pooled);
			} catch (err) {
				// BEGIN failed — release the connection so it doesn't leak,
				// then propagate the error to the caller.
				await pooled.release().catch(() => { /* swallow release errors */ });
				throw err;
			}
		})();
		return started;
	};

	const builder: SqlTransactionBuilder = {
		signal(s) {
			if (started !== undefined) throw new TypeError(SIGNAL_AFTER_START);
			abortSignal = s;
			return builder;
		},
		isolationLevel(level) {
			if (started !== undefined) throw new TypeError(ISOLATION_AFTER_START);
			perCallLevel = level;
			return builder;
		},
		then(onFulfilled, onRejected) {
			return start().then(onFulfilled, onRejected);
		},
	};
	return builder;
}

/**
 * Wrap a pooled connection (with an active server-side transaction) as
 * a {@link Transaction}. Internal — users get one of these through
 * `sql.transaction()` after BEGIN succeeds.
 */
export function makeTransaction(pooled: PooledConnection): Transaction {
	let state: TransactionState = 'open';
	const baseTag = makeSqlTag(pinnedRunner(pooled.connection));
	const conn = pooled.connection;

	function callable<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		if (state !== 'open') throw new TypeError(TX_NOT_OPEN(state));
		return baseTag<T>(strings, ...values);
	}

	const tx = callable as Transaction;
	tx.unsafe = function unsafe<T = unknown>(
		text: string,
		params?: UnsafeParams,
	): Query<T> {
		if (state !== 'open') throw new TypeError(TX_NOT_OPEN(state));
		return baseTag.unsafe<T>(text, params);
	};
	tx.commit = async function commit(): Promise<void> {
		if (state !== 'open') return;
		try {
			await conn.commit();
			state = 'committed';
		} finally {
			// Release regardless — if commit failed mid-flight, the
			// transaction state on the server is whatever it ended up
			// at; releasing the connection lets the pool reset/close it
			// per its policy (typically `conn.reset()` on release rolls
			// back any uncommitted work).
			await pooled.release().catch(() => { /* swallow release errors */ });
		}
	};
	tx.rollback = async function rollback(): Promise<void> {
		if (state !== 'open') return;
		try {
			await conn.rollback();
			state = 'rolled-back';
		} finally {
			await pooled.release().catch(() => { /* swallow */ });
		}
	};
	tx.savepoint = function savepoint(): SqlSavepointBuilder {
		if (state !== 'open') throw new TypeError(TX_NOT_OPEN(state));
		return makeSavepointBuilder(conn, baseTag, () => state);
	};
	tx[Symbol.asyncDispose] = async function dispose(): Promise<void> {
		if (state === 'open') {
			// Fall-through-without-commit defaults to rollback. Matches
			// the ADR-0006 default disposal: "rollback if not committed".
			await tx.rollback();
		}
	};
	Object.defineProperty(tx, 'state', {
		get(): TransactionState { return state; },
	});
	return tx;
}
