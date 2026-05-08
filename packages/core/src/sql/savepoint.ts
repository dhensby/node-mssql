/**
 * `Savepoint` and the `tx.savepoint()` builder (ADR-0006).
 *
 * Savepoints share the parent transaction's pinned connection and SQL
 * tag — they're a transaction-internal marker, not a new scope at the
 * connection layer. `.release()` is a no-op on SQL Server (the
 * server-side savepoint stays in place; we just mark our handle done);
 * `.rollback()` issues `ROLLBACK TRANSACTION <name>` which rolls back
 * to the savepoint, undoing work since the savepoint without ending
 * the transaction.
 *
 * Lifecycle — `Symbol.asyncDispose` rolls back if the user falls off
 * the scope without explicit `.release()` (the ADR's default-rollback
 * model, mirroring `Transaction`).
 *
 * Concurrency — the parent `Transaction`'s pinned runner already
 * serialises FIFO, and the savepoint reuses it, so concurrent queries
 * across the parent + savepoint queue together against the single
 * connection (the right behaviour: TDS only allows one request in
 * flight regardless of which scope handle issued it).
 *
 * Savepoint names — auto-generated. SQL Server constrains savepoint
 * identifiers to 32 characters and the standard identifier rules; the
 * generated name fits inside that envelope.
 */

import type { Connection } from '../driver/index.js';
import type { Query } from '../query/index.js';
import type { SqlTag, UnsafeParams } from './tag.js';
import type { TransactionState } from './transaction.js';

const SP_NOT_OPEN = (state: SavepointState): string =>
	`Savepoint is ${state}. Calling a tag or lifecycle method on a non-open savepoint is not allowed (ADR-0008).`;

const PARENT_NOT_OPEN =
	'Cannot create a savepoint on a transaction that has been committed or rolled back.';

const SIGNAL_AFTER_START =
	'signal() called on an in-flight or settled savepoint builder — set the signal before awaiting.';

export type SavepointState = 'open' | 'released' | 'rolled-back';

/**
 * A scope-marker inside a transaction. Inherits the base {@link SqlTag}
 * surface (callable + `.unsafe`) — but the underlying tag is the parent
 * transaction's, since savepoints share the connection. Adds `.release()`
 * (no-op marker) and `.rollback()` (rolls back to the savepoint),
 * plus `Symbol.asyncDispose` for `await using`.
 */
export interface Savepoint extends SqlTag, AsyncDisposable {
	release(): Promise<void>
	rollback(): Promise<void>
	readonly state: SavepointState
}

/**
 * Lazy builder returned by `tx.savepoint()`. Awaitable for the
 * {@link Savepoint} (issues `SAVE TRANSACTION <name>` on first
 * `then()`); `.signal(s)` is chainable for cancelling the savepoint
 * setup itself (rare — savepoint creation is a single round-trip).
 *
 * Note — `.isolationLevel()` is intentionally NOT on the savepoint
 * builder. SQL Server savepoints inherit the outer transaction's
 * level; the protocol has no per-savepoint override (ADR-0006).
 */
export interface SqlSavepointBuilder extends PromiseLike<Savepoint> {
	signal(signal: AbortSignal): SqlSavepointBuilder
}

// Counter for generating unique savepoint names within a process.
// Random alone would collide eventually; counter alone re-uses names
// across reconnects in ways that are confusing in trace tooling.
// Combined gives a name that's both unique within a tx (counter
// monotonic) and globally rare (random suffix). 32-char limit on SQL
// Server savepoint identifiers — `sp_<10 chars>` fits comfortably.
let savepointCounter = 0;
const generateSavepointName = (): string => {
	savepointCounter = (savepointCounter + 1) >>> 0;
	const counter = savepointCounter.toString(36);
	const rand = Math.floor(Math.random() * 0xffffff).toString(36);
	return `sp_${counter}_${rand}`;
};

/**
 * Build a {@link SqlSavepointBuilder} for the parent transaction's
 * connection + base tag. Issues `SAVE TRANSACTION <name>` on first
 * `then()`; the resulting {@link Savepoint} reuses the parent's tag
 * (so its queries share the same FIFO queue).
 *
 * `getParentState` lets the builder reject if the parent transaction
 * has been committed or rolled back BEFORE `.savepoint()` was awaited
 * — that's a logic error the user is responsible for (savepoint after
 * commit makes no sense), surfaced loudly.
 */
export function makeSavepointBuilder(
	connection: Connection,
	parentTag: SqlTag,
	getParentState: () => TransactionState,
): SqlSavepointBuilder {
	let abortSignal: AbortSignal | undefined;
	let started: Promise<Savepoint> | undefined;

	const start = (): Promise<Savepoint> => {
		if (started !== undefined) return started;
		started = (async () => {
			if (getParentState() !== 'open') {
				throw new TypeError(PARENT_NOT_OPEN);
			}
			abortSignal?.throwIfAborted();
			const name = generateSavepointName();
			await connection.savepoint(name);
			return makeSavepoint(connection, parentTag, name);
		})();
		return started;
	};

	const builder: SqlSavepointBuilder = {
		signal(s) {
			if (started !== undefined) throw new TypeError(SIGNAL_AFTER_START);
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
 * Wrap a savepoint name + its parent's tag/connection as a
 * {@link Savepoint}. Internal — users get one of these via
 * `tx.savepoint()` after `SAVE TRANSACTION` succeeds.
 */
export function makeSavepoint(
	connection: Connection,
	parentTag: SqlTag,
	name: string,
): Savepoint {
	let state: SavepointState = 'open';

	function callable<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		if (state !== 'open') throw new TypeError(SP_NOT_OPEN(state));
		return parentTag<T>(strings, ...values);
	}

	const sp = callable as Savepoint;
	sp.unsafe = function unsafe<T = unknown>(
		text: string,
		params?: UnsafeParams,
	): Query<T> {
		if (state !== 'open') throw new TypeError(SP_NOT_OPEN(state));
		return parentTag.unsafe<T>(text, params);
	};
	sp.release = async function release(): Promise<void> {
		if (state !== 'open') return;
		// SQL Server has no "release savepoint" — savepoints are
		// implicitly cleared by the outer transaction's commit /
		// rollback. We just mark the handle done so subsequent calls
		// throw, matching the ADR's "release if not rolled back" model.
		state = 'released';
	};
	sp.rollback = async function rollback(): Promise<void> {
		if (state !== 'open') return;
		await connection.rollbackToSavepoint(name);
		state = 'rolled-back';
	};
	sp[Symbol.asyncDispose] = async function dispose(): Promise<void> {
		if (state === 'open') {
			// Fall-through-without-release defaults to rollback per
			// ADR-0006 ("rollback if not released").
			await sp.rollback();
		}
	};
	Object.defineProperty(sp, 'state', {
		get(): SavepointState { return state; },
	});
	return sp;
}
