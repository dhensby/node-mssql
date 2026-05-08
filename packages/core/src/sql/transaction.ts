/**
 * `Transaction`, `Savepoint`, and the `sql.transaction()` builder
 * (ADR-0006, "Savepoints").
 *
 * `sql.transaction()` / `conn.transaction()` pins one connection and
 * issues `BEGIN TRANSACTION` (with the resolved isolation level),
 * resolving to a {@link Transaction}. Tag execution on the Transaction
 * runs on that pinned connection through the same FIFO runner as
 * `sql.acquire()`, so concurrent queries serialise and `Promise.all`
 * works.
 *
 * Within a transaction, partial rollback is done with **savepoints** —
 * transaction-managed bookmarks, *not* nested transactions. The
 * transaction owns a LIFO stack of marks:
 *
 * - `tx.savepoint()` → `SAVE TRANSACTION <name>`, pushes a mark, returns
 *   a thin {@link Savepoint} handle. Queries still run on `tx`.
 * - `sp.rollback()` / `tx.rollbackSavepoint(name?)` →
 *   `ROLLBACK TRANSACTION <name>`: discards work done since the mark and
 *   pops it (and any marks created after it) off the stack.
 * - `sp.release()` / `tx.releaseSavepoint(name?)` → drops the mark (and
 *   any after it) off the stack **keeping its work** — application-layer
 *   only, since SQL Server has no `RELEASE SAVEPOINT` verb. "I'll never
 *   come back to this point; let the next rollback go further back."
 * - `await using sp` → releases the mark if it hasn't already been rolled
 *   back or released (keeps the work; tidies the stack).
 *
 * Kept by default: a savepoint's work is part of the transaction and
 * commits with it unless explicitly rolled back. Settling the
 * transaction (`commit` / `rollback`) is one wire operation that clears
 * the whole stack — no per-savepoint ceremony, no cascade of
 * `ROLLBACK TRANSACTION <mark>` round-trips.
 *
 * Isolation level (ADR-0006): per-call `.isolationLevel()` wins; the
 * client default falls through; `'read committed'` is the library
 * default. Savepoints inherit the transaction's level.
 *
 * (A re-entrant model where `.transaction()` also nests on a
 * `Transaction` — one interchangeable scope type — is deferred future
 * work; see ADR-0006 "Alternatives considered".)
 */

import type { Connection, IsolationLevel } from '../driver/index.js';
import { savepointName } from '../ids/index.js';
import type { PooledConnection } from '../pool/index.js';
import type { Query } from '../query/index.js';
import { pinnedConnection } from './reserved-conn.js';
import { makeSqlTag, type SqlTag, type UnsafeParams } from './tag.js';

const TX_NOT_OPEN = (state: TransactionState): string =>
	`Transaction is ${state}. Calling a tag or lifecycle method on a settled transaction is not allowed (ADR-0008).`;

const TX_SETTLING =
	'Transaction is settling (commit or rollback in progress). No further queries, savepoints, or lifecycle calls are allowed (ADR-0008).';

const SP_SPENT = (state: SavepointState): string =>
	`Savepoint has been ${state} — it is no longer on the transaction's stack and cannot be rolled back to or released again (ADR-0006).`;

const NO_SAVEPOINT = (verb: string, name?: string): string =>
	name !== undefined
		? `No savepoint named "${name}" is open on this transaction.`
		: `No open savepoint to ${verb}.`;

const SIGNAL_AFTER_START =
	'signal() called on an in-flight or settled transaction builder — set the signal before awaiting.';

const ISOLATION_AFTER_START =
	'isolationLevel() called on an in-flight or settled transaction builder — set the isolation level before awaiting.';

export type TransactionState = 'open' | 'committed' | 'rolled-back';

/**
 * Runs a wire control op exclusively on the pinned connection — after all
 * prior queued operations settle, blocking subsequent ones (the pinned
 * connection's `exclusive()`). The transaction routes every wire op
 * (`BEGIN` / `COMMIT` / `ROLLBACK` / `SAVE` / `ROLLBACK TO`) through it so
 * control ops never overlap a query or one another.
 */
type Exclusive = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * A savepoint handle's lifecycle. `active` once created; `rolled-back`
 * once its work has been undone (by its own `.rollback()` or by rolling
 * back to an earlier mark); `released` once its mark has been dropped
 * keeping its work (by its own `.release()`, disposal, an earlier
 * release, or the transaction committing).
 */
export type SavepointState = 'active' | 'rolled-back' | 'released';

/**
 * The library's asserted default isolation level (ADR-0006). The
 * transaction builder uses this when neither a per-call nor client-level
 * override applies.
 */
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = 'read committed';

/**
 * A savepoint bookmark within a {@link Transaction} (ADR-0006,
 * "Savepoints"). Not a transaction — queries run on the transaction, not
 * on the savepoint. A thin handle for targeting a specific mark; the
 * transaction also exposes handle-less `tx.rollbackSavepoint()` /
 * `tx.releaseSavepoint()`.
 */
export interface Savepoint extends AsyncDisposable {
	readonly name: string
	readonly state: SavepointState
	/** Discard the work done since this mark (`ROLLBACK TRANSACTION`). */
	rollback(): Promise<void>
	/** Drop this mark, keeping its work (application-layer; no wire op). */
	release(): Promise<void>
}

/**
 * A pinned-connection transaction scope. Inherits the base {@link SqlTag}
 * surface (callable + `.unsafe`), adds `.commit()` / `.rollback()`,
 * savepoint management (`.savepoint()` / `.rollbackSavepoint()` /
 * `.releaseSavepoint()`), and `Symbol.asyncDispose` for `await using`
 * (rollback if not committed).
 */
export interface Transaction extends SqlTag, AsyncDisposable {
	commit(): Promise<void>
	rollback(): Promise<void>
	/** `SAVE TRANSACTION` — push a mark, return its handle. */
	savepoint(): Promise<Savepoint>
	/** Roll back to the most-recent (or named) savepoint. */
	rollbackSavepoint(name?: string): Promise<void>
	/** Release the most-recent (or named) savepoint, keeping its work. */
	releaseSavepoint(name?: string): Promise<void>
	readonly state: TransactionState
}

/**
 * Lazy builder returned by `.transaction()`. Awaitable for the
 * {@link Transaction} (acquire + BEGIN); chainable `.signal(s)` and
 * `.isolationLevel(level)` configure the wait and the BEGIN's level
 * before the builder is awaited.
 */
export interface SqlTransactionBuilder extends PromiseLike<Transaction> {
	signal(signal: AbortSignal): SqlTransactionBuilder
	isolationLevel(level: IsolationLevel): SqlTransactionBuilder
}

const swallow = (): void => { /* release / settle errors during teardown are unrecoverable */ };

/**
 * Core constructor for a {@link Transaction} over a freshly-begun
 * connection. `release` returns the connection on settle (a pooled
 * release, or a no-op when the connection is owned by a `ReservedConn`).
 * Internal — users get one of these through a builder after BEGIN.
 */
export function makeTransaction(
	connection: Connection,
	baseTag: SqlTag,
	exclusive: Exclusive,
	release: () => Promise<void>,
): Transaction {
	let state: TransactionState = 'open';
	// Held finalisation promise (commit/rollback). Set synchronously by the
	// first settle call; once set, the transaction accepts no further work
	// and every later commit / rollback / dispose awaits this same promise.
	let settle: Promise<void> | null = null;

	// The savepoint stack — marks in creation order. Each entry can spend
	// its handle (flip its observable state) when popped.
	interface Entry { readonly name: string; spend(state: SavepointState): void }
	const stack: Entry[] = [];

	// Gate every query / savepoint / lifecycle call: open AND not yet
	// settling. The `settle` check closes the window between an (unawaited)
	// commit/rollback starting and `state` flipping once its wire op lands —
	// so a query can't slip onto the connection after a COMMIT was issued.
	const assertOpen = (): void => {
		if (state !== 'open') throw new TypeError(TX_NOT_OPEN(state));
		if (settle !== null) throw new TypeError(TX_SETTLING);
	};

	// Pop the stack down to (and including) index `i`, spending every popped
	// entry — `i` and everything above it — with `settled`. A negative `i`
	// (target already gone — e.g. popped by a concurrent settle) is a no-op,
	// which also keeps `stack.length` from going negative.
	const popTo = (i: number, settled: SavepointState): void => {
		if (i < 0) return;
		for (let j = stack.length - 1; j >= i; j--) {
			stack[j]?.spend(settled);
		}
		stack.length = i;
	};

	// Locate a mark by name, or the top of the stack if no name. -1 if absent.
	const indexOf = (name?: string): number => {
		if (name === undefined) return stack.length - 1;
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i]?.name === name) return i;
		}
		return -1;
	};

	function callable<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		assertOpen();
		return baseTag<T>(strings, ...values);
	}

	const tx = callable as Transaction;

	tx.unsafe = function unsafe<T = unknown>(
		text: string,
		params?: UnsafeParams,
	): Query<T> {
		assertOpen();
		return baseTag.unsafe<T>(text, params);
	};

	tx.savepoint = async function savepoint(): Promise<Savepoint> {
		assertOpen();
		// Wire identifier — SQL-safe by construction, never an idGenerator
		// override (ADR-0016). The driver validates defensively too.
		const name = savepointName();
		let spState: SavepointState = 'active';
		const entry: Entry = { name, spend: (s) => { spState = s; } };
		// Serialise the SAVE behind any in-flight query / control op, pushing
		// the mark only once it lands — so parallel savepoint() calls create
		// marks in queue order instead of racing two SAVEs onto one wire.
		await exclusive(async () => {
			assertOpen(); // re-check under the slot — a settle may have won the race
			await connection.savepoint(name); // SAVE TRANSACTION <name>
			stack.push(entry);
		});

		const sp: Savepoint = {
			name,
			get state(): SavepointState { return spState; },
			async rollback(): Promise<void> {
				if (spState !== 'active') throw new TypeError(SP_SPENT(spState));
				await exclusive(async () => {
					if (spState !== 'active') return; // spent while queued
					assertOpen();
					await connection.rollbackToSavepoint(entry.name); // ROLLBACK TRANSACTION <name>
					popTo(stack.indexOf(entry), 'rolled-back');
				});
			},
			async release(): Promise<void> {
				if (spState !== 'active') throw new TypeError(SP_SPENT(spState));
				assertOpen();
				// Application-layer only (no wire op) and synchronous, so it
				// can't interleave with an in-flight rollback's stack pop.
				popTo(stack.indexOf(entry), 'released');
			},
			async [Symbol.asyncDispose](): Promise<void> {
				// Forgiving: release the mark (keep its work) only if it's
				// still live and the transaction is still open and not
				// settling. A spent mark, or one whose transaction already
				// settled, is a no-op.
				if (spState !== 'active' || state !== 'open' || settle !== null) return;
				popTo(stack.indexOf(entry), 'released');
			},
		};
		return sp;
	};

	tx.rollbackSavepoint = async function rollbackSavepoint(name?: string): Promise<void> {
		assertOpen();
		await exclusive(async () => {
			assertOpen();
			const i = indexOf(name);
			if (i < 0) throw new TypeError(NO_SAVEPOINT('roll back to', name));
			await connection.rollbackToSavepoint(stack[i]!.name); // ROLLBACK TRANSACTION <name>
			popTo(i, 'rolled-back');
		});
	};

	tx.releaseSavepoint = async function releaseSavepoint(name?: string): Promise<void> {
		assertOpen();
		const i = indexOf(name);
		if (i < 0) throw new TypeError(NO_SAVEPOINT('release', name));
		popTo(i, 'released'); // application-layer only — no wire op
	};

	// commit/rollback share one held finalisation promise: the first caller
	// wins; later commit / rollback / dispose all await the same settle. The
	// guard flips `settle` synchronously (before the wire op), so a parallel
	// or unawaited commit can neither double-settle nor be turned into a
	// rollback by disposal. The wire op is serialised behind any in-flight
	// query; one stack-clear then settles every open savepoint (no per-mark
	// cascade — marks kept on commit, discarded on rollback).
	const finalise = (
		wire: () => Promise<void>,
		settled: Exclude<TransactionState, 'open'>,
	): Promise<void> => {
		if (settle !== null) return settle;
		settle = (async () => {
			try {
				await exclusive(wire);
				state = settled;
			} finally {
				popTo(0, settled === 'committed' ? 'released' : 'rolled-back');
				await release().catch(swallow);
			}
		})();
		return settle;
	};

	tx.commit = function commit(): Promise<void> {
		return finalise(() => connection.commit(), 'committed');
	};

	tx.rollback = function rollback(): Promise<void> {
		return finalise(() => connection.rollback(), 'rolled-back');
	};

	tx[Symbol.asyncDispose] = function dispose(): Promise<void> {
		// Already settling/settled → await that (the caller owns any error).
		// Otherwise fall-through-without-commit defaults to rollback (ADR-0006).
		return settle !== null ? settle.catch(swallow) : tx.rollback();
	};

	Object.defineProperty(tx, 'state', {
		get(): TransactionState { return state; },
	});

	return tx;
}

// Open a top-level transaction over an obtained connection: `BEGIN
// TRANSACTION`, then wrap. BEGIN is serialised through `exclusive` so it
// queues behind any in-flight query on a reserved connection. On BEGIN
// failure the connection is released (a pooled release; a no-op for a
// reserved connection) so nothing leaks.
async function beginTransaction(
	connection: Connection,
	baseTag: SqlTag,
	exclusive: Exclusive,
	release: () => Promise<void>,
	level: IsolationLevel,
): Promise<Transaction> {
	try {
		await exclusive(() => connection.beginTransaction({ isolationLevel: level }));
		return makeTransaction(connection, baseTag, exclusive, release);
	} catch (err) {
		await release().catch(swallow);
		throw err;
	}
}

interface TxConnection {
	readonly connection: Connection
	readonly baseTag: SqlTag
	readonly exclusive: Exclusive
	release(): Promise<void>
}

// Shared builder over a connection source — the only difference between
// the pool-bound and reserved-connection forms is how the connection
// (and its FIFO queue) is obtained.
function makeBuilder(
	source: (signal?: AbortSignal) => Promise<TxConnection>,
	defaultLevel: IsolationLevel,
): SqlTransactionBuilder {
	let abortSignal: AbortSignal | undefined;
	let perCallLevel: IsolationLevel | undefined;
	let started: Promise<Transaction> | undefined;

	const start = (): Promise<Transaction> => {
		if (started !== undefined) return started;
		started = (async () => {
			const { connection, baseTag, exclusive, release } = await source(abortSignal);
			return beginTransaction(connection, baseTag, exclusive, release, perCallLevel ?? defaultLevel);
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
 * Build a pool-bound {@link SqlTransactionBuilder} that acquires a fresh
 * pinned connection and issues `BEGIN TRANSACTION` on first `then()`.
 *
 * `defaultLevel` is the client-level fallback (itself falling through to
 * the library default `'read committed'`); per-call `.isolationLevel()`
 * overrides it.
 */
export function makeTransactionBuilder(
	acquire: (signal?: AbortSignal) => Promise<PooledConnection>,
	defaultLevel: IsolationLevel,
): SqlTransactionBuilder {
	return makeBuilder(async (signal) => {
		const pooled = await acquire(signal);
		const pinned = pinnedConnection(pooled.connection);
		return {
			connection: pooled.connection,
			baseTag: makeSqlTag(pinned.runner),
			exclusive: pinned.exclusive,
			release: () => pooled.release(),
		};
	}, defaultLevel);
}

/**
 * Build a {@link SqlTransactionBuilder} over an already-held reserved
 * connection (`sql.acquire()`'s `ReservedConn`). Shares the reserved
 * connection AND its FIFO queue — `baseTag` for queries, `exclusive` for
 * control ops — so transaction work and bare reserved-connection queries
 * all serialise on one queue. Its `release` is a **no-op**: the
 * `ReservedConn` owns the connection's pool lifecycle, so committing or
 * rolling back the transaction must not return it to the pool.
 */
export function makeReservedTransactionBuilder(
	connection: Connection,
	baseTag: SqlTag,
	exclusive: Exclusive,
	defaultLevel: IsolationLevel,
): SqlTransactionBuilder {
	return makeBuilder(async () => ({
		connection,
		baseTag,
		exclusive,
		release: async () => { /* no-op — the ReservedConn owns the connection */ },
	}), defaultLevel);
}
