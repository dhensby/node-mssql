/**
 * `PoolBoundSqlTag` — the pool-level extension of {@link SqlTag}
 * (ADR-0006). Adds scope-builder methods that only make sense at the
 * pool layer:
 *
 * - `.acquire()` — reserves a fresh connection from the pool (the
 *   `ReservedConn` adds nothing on top of the base {@link SqlTag}
 *   that justifies a nested `.acquire()` on a pinned scope).
 * - `.transaction()` — opens a server-side transaction on a freshly
 *   reserved connection, with the resolved isolation level.
 *
 * The base {@link SqlTag} (callable + `.unsafe`) is what's present on
 * every scope (pool-bound, ReservedConn, Transaction, Savepoint).
 *
 * Internal: the {@link Client} constructs one of these for its
 * `client.sql` and passes the pool's `acquire` function alongside the
 * underlying {@link RequestRunner} and the resolved client default
 * isolation level.
 */

import type { IsolationLevel } from '../driver/index.js';
import type { PooledConnection } from '../pool/index.js';
import type { RequestRunner } from '../query/index.js';
import {
	makeAcquireBuilder,
	type SqlAcquireBuilder,
} from './reserved-conn.js';
import { makeSqlTag, type SqlTag } from './tag.js';
import {
	DEFAULT_ISOLATION_LEVEL,
	makeTransactionBuilder,
	type SqlTransactionBuilder,
} from './transaction.js';

/**
 * Pool-bound tag — extends {@link SqlTag} with scope builders. Returned
 * by {@link makePoolBoundSqlTag}; assigned to `client.sql`.
 */
export interface PoolBoundSqlTag extends SqlTag {
	/**
	 * Reserve a connection from the pool for the duration of an
	 * `await using` (or until explicit `.release()`). Returns a chainable
	 * {@link SqlAcquireBuilder} — `.signal(s)` sets the abort signal
	 * propagated to the pool's acquire wait.
	 *
	 * ```ts
	 * await using conn = await sql.acquire()
	 * await conn`create table #items (id int)`.run()
	 * await conn`insert into #items ...`.run()
	 * ```
	 */
	acquire(): SqlAcquireBuilder

	/**
	 * Open a server-side transaction on a freshly-reserved connection.
	 * Returns a chainable {@link SqlTransactionBuilder} — `.signal(s)`
	 * threads an abort signal into the acquire + BEGIN; `.isolationLevel`
	 * overrides the client-level default for THIS transaction.
	 *
	 * ```ts
	 * await using tx = await sql.transaction()                       // client default level
	 * await using tx = await sql.transaction().isolationLevel('snapshot')
	 * ```
	 *
	 * Disposal default is rollback if neither `.commit()` nor
	 * `.rollback()` was called inside the scope.
	 */
	transaction(): SqlTransactionBuilder
}

/**
 * Build a {@link PoolBoundSqlTag} from a `RequestRunner` (for the
 * callable + `.unsafe` path, gated on Client state), a pool acquire
 * function (for `.acquire()` / `.transaction()`), and a default
 * isolation level (for `.transaction()` when no per-call override).
 *
 * The runner / acquire split is intentional. The runner already
 * handles the Client's state gate (rejecting on `pending` /
 * `draining` / `destroyed`); the acquire function is the bare pool
 * call so `sql.acquire()` rejects with the pool's own
 * `PoolClosedError` rather than the Client's `ClientNotConnected` —
 * acquire failure messaging matches what the user is reaching for.
 */
export function makePoolBoundSqlTag(
	runner: RequestRunner,
	acquire: (signal?: AbortSignal) => Promise<PooledConnection>,
	defaultIsolationLevel: IsolationLevel = DEFAULT_ISOLATION_LEVEL,
): PoolBoundSqlTag {
	const tag = makeSqlTag(runner) as PoolBoundSqlTag;
	// Thread the client default isolation level into `.acquire()` too, so a
	// transaction started on a `ReservedConn` (`conn.transaction()`) honours
	// it just as `sql.transaction()` does.
	tag.acquire = (): SqlAcquireBuilder => makeAcquireBuilder(acquire, defaultIsolationLevel);
	tag.transaction = (): SqlTransactionBuilder =>
		makeTransactionBuilder(acquire, defaultIsolationLevel);
	return tag;
}
