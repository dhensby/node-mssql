/**
 * `PoolBoundSqlTag` — the pool-level extension of {@link SqlTag}
 * (ADR-0006). Adds scope-builder methods that only make sense at the
 * pool layer (`.acquire()` reserves a connection; future round-outs
 * add `.transaction()` and `.ping()`).
 *
 * The base {@link SqlTag} (callable + `.unsafe`) is what's present on
 * every scope (pool-bound, ReservedConn, Transaction, Savepoint).
 * `.acquire()` is pool-only because it's "give me a fresh pinned
 * connection from the pool" — not meaningful inside a scope that's
 * already pinned to a single connection.
 *
 * Internal: the {@link Client} constructs one of these for its
 * `client.sql` and passes the pool's `acquire` function alongside the
 * underlying {@link RequestRunner}.
 */

import type { PooledConnection } from '../pool/index.js';
import type { RequestRunner } from '../query/index.js';
import {
	makeAcquireBuilder,
	type SqlAcquireBuilder,
} from './reserved-conn.js';
import { makeSqlTag, type SqlTag } from './tag.js';

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
}

/**
 * Build a {@link PoolBoundSqlTag} from a `RequestRunner` (for the
 * callable + `.unsafe` path, gated on Client state) and a pool acquire
 * function (for `.acquire()`).
 *
 * The two arguments are intentionally separate. The runner already
 * handles the Client's state gate (rejecting on `pending` /
 * `draining` / `destroyed`); the acquire function is the bare pool
 * call so `sql.acquire()` rejects with the pool's own
 * `PoolClosedError` rather than the Client's `ClientNotConnected` —
 * acquire failure messaging matches what the user is reaching for.
 */
export function makePoolBoundSqlTag(
	runner: RequestRunner,
	acquire: (signal?: AbortSignal) => Promise<PooledConnection>,
): PoolBoundSqlTag {
	const tag = makeSqlTag(runner) as PoolBoundSqlTag;
	tag.acquire = (): SqlAcquireBuilder => makeAcquireBuilder(acquire);
	return tag;
}
