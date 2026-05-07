/**
 * `Query<T>` — single-rowset surface (ADR-0006 / ADR-0007 / ADR-0008).
 *
 * Round-out cut (R-1): adds the rest of the single-rowset terminals on
 * top of V-1's `.then()` / `.all()`. The class is still missing
 * `.columns()`, `.raw()`, `.cancel()`, `.dispose()`, AsyncDisposable,
 * and `.rowsets()` — those land in subsequent round-out commits.
 *
 * Implementation shape:
 *
 * - `#streamEvents()` is the single internal generator that drives the
 *   runner stream. It accumulates trailer data into `#trailer` and
 *   yields each `ResultEvent` to the caller. All consuming terminals
 *   (`all` / `iterate` / `run` / `result`) consume this generator;
 *   trailer accumulation is automatic regardless of which terminal
 *   fired.
 * - Row-consuming terminals (`all`, `iterate`, `result`) share the
 *   `#consumeRows()` async generator which yields shaped rows and
 *   throws `MultipleRowsetsError` on a second metadata token. `result`
 *   is `all` + `meta()` in one shape; both delegate to `#consumeRows`
 *   so single-consumption is enforced once across them.
 * - Drain-only terminal (`run`) consumes `#streamEvents()` directly,
 *   ignoring rows and rowset boundaries — drain-only paths are
 *   "deliberately oblivious to rowset boundaries" per ADR-0006.
 * - `.meta()` is a sync getter on the trailer state. Throws `TypeError`
 *   if the stream hasn't terminated (mirroring `Response.headers` /
 *   `xhr.getAllResponseHeaders()` / Node streams' `readableEnded`).
 * - Single-consumption is enforced via `#consumed`. The flag flips on
 *   the first row-consuming terminal call; subsequent calls throw
 *   synchronously at terminal entry.
 */

import type { ColumnMetadata, ExecuteRequest, ResultEvent } from '../driver/index.js';
import { MultipleRowsetsError } from '../errors/index.js';
import type { EnvChange, InfoMessage, QueryMeta } from './meta.js';
import type { RequestRunner } from './runner.js';

export interface QueryOptions {
	readonly runner: RequestRunner
	readonly request: ExecuteRequest
	readonly signal?: AbortSignal
	// View-toggle flag set by `.raw()`. Internal — users access this
	// path via `query.raw()`, never directly.
	readonly rawMode?: boolean
}

// Internal mutable trailer accumulator. Public `QueryMeta` is the
// readonly view returned from `.meta()` / `.result()` / `.run()`.
interface MutableTrailer {
	rowsAffected: number
	rowsAffectedPerStatement: number[]
	info: InfoMessage[]
	print: string[]
	envChanges: EnvChange[]
	output: Record<string, unknown>
	returnValue: number | undefined
	completed: boolean
}

const createTrailer = (): MutableTrailer => ({
	rowsAffected: 0,
	rowsAffectedPerStatement: [],
	info: [],
	print: [],
	envChanges: [],
	output: {},
	returnValue: undefined,
	completed: false,
});

// `MutableTrailer` is structurally compatible with `QueryMeta` (mutable
// arrays / object widen to readonly variants); cast keeps things
// allocation-free per `.meta()` call. Snapshotting would be defensive
// but the trailer is trusted internal state — once terminated, no
// further updates run.
const snapshotMeta = <O>(t: MutableTrailer): QueryMeta<O> =>
	t as unknown as QueryMeta<O>;

const ALREADY_CONSUMED =
	'Query already consumed. Each Query<T> is single-consumption; build a new Query (call the tag again) to re-run.';

const DISPOSED =
	'Query has been disposed. Calling a terminal on a disposed Query is not allowed (ADR-0008).';

const META_BEFORE_TERMINATION =
	'Query.meta() called before the stream terminated. ' +
	'Await a row-consuming terminal (`.all()` / `.iterate()` / `.run()` / `.result()`) first; ' +
	'`.meta()` returns the trailer once the stream has drained (or errored / been cancelled).';

const ROW_BEFORE_METADATA =
	'driver emitted a row event before metadata — driver bug';

const MULTIPLE_ROWSETS =
	'query produced multiple rowsets; use .rowsets() to consume them';

export class Query<T = unknown> implements
	PromiseLike<T[]>,
	AsyncIterable<T>,
	AsyncDisposable
{
	readonly #runner: RequestRunner;
	readonly #request: ExecuteRequest;
	readonly #signal: AbortSignal | undefined;
	readonly #rawMode: boolean;

	#consumed = false;
	#terminated = false;
	#disposed = false;
	readonly #trailer: MutableTrailer = createTrailer();

	// Internal controller for `.cancel()` / `.dispose()` to abort the
	// in-flight runner stream. Lazily allocated — Queries that never
	// fire a terminal don't pay for an `AbortController` they'll never
	// use.
	#ownAbortController: AbortController | null = null;
	// Cached composite signal — the union of `this.#signal` (consumer-
	// supplied) and the own controller's signal. Built on first
	// `#composedSignal()` call.
	#compositeSignal: AbortSignal | undefined;

	// Resolves when `#streamEvents` fully terminates (its `finally`
	// fires). `cancel()` and `dispose()` await this so they don't
	// resolve until the runner stream has settled — load-bearing for
	// the connection-release ordering: the surrounding poolRunner's
	// `await using pooled` disposal must not fire until tedious has
	// settled the cancel response, otherwise `Connection.reset()` runs
	// on top of an unsettled cancel.
	#terminationPromise: Promise<void> | null = null;
	#terminationResolve: (() => void) | null = null;

	constructor(options: QueryOptions) {
		this.#runner = options.runner;
		this.#request = options.request;
		this.#signal = options.signal;
		this.#rawMode = options.rawMode ?? false;
	}

	// ─── PromiseLike ──────────────────────────────────────────────────────

	/**
	 * `await query` is the most common consumption shape; this thenable
	 * hook makes it work without an explicit `.all()` call. Each `await`
	 * counts as a single consumption — a second `await` on the same
	 * `Query` rejects via `.all()`'s single-consumption guard.
	 */
	then<R1 = T[], R2 = never>(
		onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
		onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
	): PromiseLike<R1 | R2> {
		return this.all().then(onFulfilled, onRejected);
	}

	// ─── AsyncIterable ────────────────────────────────────────────────────

	/**
	 * `for await (const row of query)` works directly on the Query — the
	 * async-iterator protocol delegates to {@link Query.iterate}.
	 */
	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this.iterate();
	}

	// ─── Row-consuming terminals (single-consumption) ────────────────────

	/**
	 * Drain the stream and return rows as objects.
	 *
	 * Single-rowset terminal: throws {@link MultipleRowsetsError} if a
	 * second metadata token arrives. Use `.rowsets()` for multi-rowset
	 * queries (lands in a round-out commit).
	 */
	async all(): Promise<T[]> {
		this.#claimConsumption();
		const rows: T[] = [];
		for await (const row of this.#consumeRows()) {
			rows.push(row);
		}
		return rows;
	}

	/**
	 * Stream rows one at a time. Returns an `AsyncIterableIterator<T>`
	 * suitable for `for await`. Single-rowset terminal — throws
	 * {@link MultipleRowsetsError} on a second metadata token.
	 *
	 * Breaking out of a `for await` loop calls the iterator's `return()`,
	 * which propagates through `#streamEvents()` to the runner — for
	 * pool-bound runners that cancels the in-flight request and releases
	 * the connection (per ADR-0008).
	 */
	iterate(): AsyncIterableIterator<T> {
		this.#claimConsumption();
		return this.#consumeRows();
	}

	/**
	 * Drain the stream without buffering rows; returns the trailer.
	 *
	 * Drain-only paths are intentionally oblivious to rowset boundaries
	 * (ADR-0006) — `.run()` does NOT throw `MultipleRowsetsError` if the
	 * statement produces multiple rowsets. Use it for DML where you only
	 * care about row counts / output params, or when you want to drain a
	 * statement without paying the cost of buffering rows.
	 */
	async run<O = Record<string, never>>(): Promise<QueryMeta<O>> {
		this.#claimConsumption();
		for await (const _event of this.#streamEvents()) {
			// Drain. Trailer is accumulated by `#streamEvents` itself.
		}
		return snapshotMeta<O>(this.#trailer);
	}

	/**
	 * Buffer all rows AND return the trailer in a single shape. Inline-
	 * friendly for DML with `OUTPUT` and procedures whose `output`
	 * parameters are wanted alongside rows. Equivalent to `.all()` +
	 * `.meta()` but avoids holding the Query reference for two calls
	 * (ADR-0006).
	 */
	async result<O = Record<string, never>>(): Promise<{
		rows: T[]
		meta: QueryMeta<O>
	}> {
		this.#claimConsumption();
		const rows: T[] = [];
		for await (const row of this.#consumeRows()) {
			rows.push(row);
		}
		return { rows, meta: snapshotMeta<O>(this.#trailer) };
	}

	// ─── View toggle (non-consuming) ─────────────────────────────────────

	/**
	 * View toggle to a positional-tuple row shape (ADR-0007).
	 *
	 * Returns a NEW `Query<R>` whose row-consuming terminals yield rows
	 * as `R` (a positional tuple) instead of objects. Each value lands
	 * at the index reported by `.columns()`, preserving duplicate column
	 * values that the default object shape collapses last-wins.
	 *
	 * `.raw()` does NOT consume the original Query — it's a builder, not
	 * a terminal (per ADR-0007 / ADR-0006). Each call returns a fresh
	 * `Query`, and execution starts only when a terminal fires on the
	 * returned Query (lazy). The original Query remains independently
	 * consumable; calling its terminals runs a separate round-trip.
	 *
	 * Tuple element type defaults to `unknown[]`; callers narrow with a
	 * tuple type argument: `q.raw<[number, string]>()`.
	 */
	raw<R = unknown[]>(): Query<R> {
		return new Query<R>({
			runner: this.#runner,
			request: this.#request,
			...(this.#signal !== undefined ? { signal: this.#signal } : {}),
			rawMode: true,
		});
	}

	// ─── Trailer access (non-consuming) ──────────────────────────────────

	/**
	 * Synchronous accessor for trailer data — row counts, info / print /
	 * envChange messages, output parameters, return status. Throws
	 * `TypeError` if the stream hasn't yet terminated; the natural
	 * sequence is to await a row-consuming terminal first, then read
	 * `.meta()`.
	 *
	 * On non-natural exit (`break` from `for await`, signal abort, error
	 * mid-stream), the stream still terminates and `.meta()` returns the
	 * trailer accumulated up to that point with `completed: false`.
	 */
	meta<O = Record<string, never>>(): QueryMeta<O> {
		if (!this.#terminated) {
			throw new TypeError(META_BEFORE_TERMINATION);
		}
		return snapshotMeta<O>(this.#trailer);
	}

	// ─── Cancellation & disposal ─────────────────────────────────────────

	/**
	 * Issue a driver-level cancel for the in-flight stream (or pre-arm
	 * the cancellation if no terminal has fired yet — the next terminal
	 * call sees an already-aborted signal and rejects).
	 *
	 * Same effect as `.dispose()` on an in-flight stream — both abort
	 * the underlying runner via `AbortSignal`. Differs in that
	 * `.cancel()` doesn't mark the Query as disposed: subsequent
	 * `.meta()` calls return the partial trailer (with `completed: false`),
	 * and `.cancel()` is idempotent (repeat calls no-op).
	 */
	async cancel(): Promise<void> {
		if (this.#ownAbortController === null) {
			this.#ownAbortController = new AbortController();
		}
		if (!this.#ownAbortController.signal.aborted) {
			this.#ownAbortController.abort();
		}
		// Await full runner-stream termination if a stream is in flight.
		// This is load-bearing — without the wait, the surrounding
		// poolRunner's `await using pooled` disposal would fire while
		// the runner is still settling (e.g. tedious mid-cancel-response),
		// and `Connection.reset()` would corrupt the connection for the
		// next acquire. See ADR-0023's cancel-then-settle ordering.
		if (this.#terminationPromise !== null && !this.#terminated) {
			await this.#terminationPromise;
		}
	}

	/**
	 * `await using` resource cleanup — cancels any in-flight stream and
	 * marks the Query as disposed. Subsequent terminal calls throw
	 * `TypeError`.
	 *
	 * Idempotent — repeat calls return immediately.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.cancel();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.dispose();
	}

	// ─── Internal: shared stream consumption + trailer accumulation ──────

	#claimConsumption(): void {
		if (this.#disposed) {
			throw new TypeError(DISPOSED);
		}
		if (this.#consumed) {
			throw new TypeError(ALREADY_CONSUMED);
		}
		this.#consumed = true;
	}

	// Composite signal for the runner — union of the consumer-supplied
	// signal and our own controller. Either source firing aborts the
	// runner. Lazily built on first stream start.
	#composedSignal(): AbortSignal | undefined {
		if (this.#compositeSignal !== undefined) return this.#compositeSignal;
		if (this.#ownAbortController === null) {
			this.#ownAbortController = new AbortController();
		}
		this.#compositeSignal = this.#signal !== undefined
			? AbortSignal.any([this.#signal, this.#ownAbortController.signal])
			: this.#ownAbortController.signal;
		return this.#compositeSignal;
	}

	// Driver-stream consumer. Updates the trailer for every event and
	// yields each event to the caller. Sets `#terminated` in `finally`
	// so abnormal exits (consumer break, runner error) still mark the
	// stream as terminated for `.meta()` access. `#completed` is set
	// only on natural drain.
	async *#streamEvents(): AsyncIterable<ResultEvent> {
		// Set up termination promise on first stream start. `cancel()` /
		// `dispose()` await this so a cancel returns only after the
		// runner has fully unwound — including the runner's own
		// cleanup work (`bridge.destroy()` for tedious, etc).
		this.#terminationPromise = new Promise<void>((res) => {
			this.#terminationResolve = res;
		});
		try {
			for await (const event of this.#runner.run(this.#request, this.#composedSignal())) {
				this.#updateTrailer(event);
				yield event;
			}
			this.#trailer.completed = true;
		} finally {
			this.#terminated = true;
			this.#terminationResolve?.();
		}
	}

	// Row-consuming layer over `#streamEvents`. Yields shaped rows.
	// Throws `MultipleRowsetsError` if a second metadata token arrives
	// — ADR-0006's "row-promising terminals" contract.
	async *#consumeRows(): AsyncIterableIterator<T> {
		let firstRowsetEnded = false;
		let columns: readonly ColumnMetadata[] | null = null;
		for await (const event of this.#streamEvents()) {
			switch (event.kind) {
				case 'metadata':
					if (firstRowsetEnded) {
						throw new MultipleRowsetsError(MULTIPLE_ROWSETS);
					}
					columns = event.columns;
					break;
				case 'row':
					if (columns === null) {
						throw new Error(ROW_BEFORE_METADATA);
					}
					// `.raw()` mode: yield the values tuple verbatim, preserving
					// duplicate-column values by index. Default mode: shape into
					// an object keyed by column name, last-wins on duplicates
					// (ADR-0007).
					yield this.#rawMode
						? (event.values as T)
						: shapeRow<T>(event.values, columns);
					break;
				case 'rowsetEnd':
					firstRowsetEnded = true;
					break;
				// Trailer events (output / returnValue / info / print /
				// envChange) are accumulated by `#streamEvents` via
				// `#updateTrailer`; this layer doesn't need to react.
				// `done` is the natural-end marker — also a no-op here.
			}
		}
	}

	#updateTrailer(event: ResultEvent): void {
		const t = this.#trailer;
		switch (event.kind) {
			case 'rowsetEnd':
				t.rowsAffected += event.rowsAffected;
				t.rowsAffectedPerStatement.push(event.rowsAffected);
				return;
			case 'output':
				t.output[event.name] = event.value;
				return;
			case 'returnValue':
				t.returnValue = event.value;
				return;
			case 'info': {
				const msg: InfoMessage = {
					number: event.number,
					state: event.state,
					class: event.class,
					message: event.message,
					...(event.serverName !== undefined ? { serverName: event.serverName } : {}),
					...(event.procName !== undefined ? { procName: event.procName } : {}),
					...(event.lineNumber !== undefined ? { lineNumber: event.lineNumber } : {}),
				};
				t.info.push(msg);
				return;
			}
			case 'print':
				t.print.push(event.message);
				return;
			case 'envChange':
				t.envChanges.push({
					type: event.type,
					oldValue: event.oldValue,
					newValue: event.newValue,
				});
				return;
			// metadata / row / done aren't trailer events — ignored here.
		}
	}
}

// Build an object row from a `ResultEvent.values` tuple plus the latest
// column metadata. Last-wins on duplicate names is a natural fallout of
// object-key assignment (ADR-0007).
function shapeRow<T>(
	values: readonly unknown[],
	columns: readonly ColumnMetadata[],
): T {
	const obj: Record<string, unknown> = {};
	for (let i = 0; i < columns.length; i++) {
		const col = columns[i];
		if (col === undefined) continue;
		obj[col.name] = values[i];
	}
	return obj as T;
}
