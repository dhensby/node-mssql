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

	// Resolves when the runner stream fully terminates (`#streamEvents`
	// `finally` or shape pump's end / error / cancel). `cancel()` and
	// `dispose()` await this so they don't resolve until the runner has
	// settled — load-bearing for the connection-release ordering: the
	// surrounding poolRunner's `await using pooled` disposal must not
	// fire until tedious has settled the cancel response, otherwise
	// `Connection.reset()` runs on top of an unsettled cancel.
	#terminationPromise: Promise<void> | null = null;
	#terminationResolve: (() => void) | null = null;

	// Single shared runner iterator at instance level — both the
	// shape-only pump (for `.columns()`) and the row-terminal stream
	// consumer pull from this. Lazy-init on first pull.
	#runnerIter: AsyncIterator<ResultEvent> | null = null;

	// Events pulled by the shape-only pump (when `.columns()` runs alone)
	// but not yet handed to a row terminal. The row terminal drains this
	// before continuing from `#runnerIter`.
	#lookahead: ResultEvent[] = [];

	// Stored stream-level error. The shape-only pump catches errors
	// here so a row terminal called later can re-throw them. Also set
	// by `#streamEvents`'s catch so a `.columns()` call after a failed
	// terminal can reject promptly.
	#streamError: Error | null = null;

	// Shape pump's run promise — non-null while it's in flight or
	// after it has settled. Row terminals await this so the lookahead
	// is fully populated before they drain.
	#shapePumpPromise: Promise<void> | null = null;

	// Captured-once first-rowset columns. Returned by `.columns()` and
	// resolved internally by `#streamEvents` when metadata arrives
	// during normal terminal consumption.
	#firstColumns: readonly ColumnMetadata[] | null = null;
	#columnsPromise: Promise<readonly ColumnMetadata[]> | null = null;
	#columnsResolve: ((cols: readonly ColumnMetadata[]) => void) | null = null;
	#columnsReject: ((err: unknown) => void) | null = null;

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

	// ─── Shape introspection (non-consuming) ─────────────────────────────

	/**
	 * Resolve the column metadata for the FIRST rowset (ADR-0007).
	 *
	 * Locked to the first rowset — multiple calls return the same
	 * Promise. If a row-consuming terminal has already fired, the
	 * returned Promise resolves when metadata flows through the shared
	 * stream (or immediately if it's already been seen). If no terminal
	 * has fired yet, `.columns()` kicks off a "shape-only pump" that
	 * pulls events from the runner until the first metadata token, then
	 * stops — the runner iterator is left paused, with driver-level
	 * backpressure holding the connection until either a row terminal
	 * continues consumption or `.dispose()` cancels and releases.
	 *
	 * Edge cases:
	 * - No rowsets (e.g. pure DML): resolves to `[]` when the stream
	 *   ends without ever emitting metadata.
	 * - Stream errors before metadata: rejects with the same error
	 *   the row terminal would have surfaced.
	 * - Disposed Query: rejects with `TypeError`.
	 */
	columns(): Promise<readonly ColumnMetadata[]> {
		if (this.#disposed) {
			return Promise.reject(new TypeError(DISPOSED));
		}
		// Already-resolved fast path.
		if (this.#firstColumns !== null) {
			return Promise.resolve(this.#firstColumns);
		}
		// Cached pending promise.
		if (this.#columnsPromise !== null) {
			return this.#columnsPromise;
		}
		// Stream already terminated without metadata — settle synchronously.
		// Either the row terminal drained without ever seeing metadata
		// (resolve []) or it errored before metadata (reject with error).
		if (this.#terminated) {
			if (this.#streamError !== null) {
				return Promise.reject(this.#streamError);
			}
			this.#firstColumns = [];
			return Promise.resolve(this.#firstColumns);
		}
		// Set up the pending Promise and (if no terminal has fired yet)
		// kick off the shape-only pump.
		this.#columnsPromise = new Promise<readonly ColumnMetadata[]>((resolve, reject) => {
			this.#columnsResolve = resolve;
			this.#columnsReject = reject;
		});
		if (!this.#consumed && this.#shapePumpPromise === null) {
			this.#shapePumpPromise = this.#runShapePump();
		}
		return this.#columnsPromise;
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

		// Shape-only path: a `.columns()` shape pump has paused the
		// runner iterator and there's no row terminal consuming. The
		// signal abort alone won't wake the suspended runner generator
		// (it's parked at `yield`, not awaiting events.on). Call
		// `iter.return()` to abruptly terminate the generator and
		// trigger its cleanup chain (poolRunner's `await using pooled`
		// → release; tedious's bridge.destroy() → cancel-ack wait). The
		// `await` is load-bearing for the cancel-then-settle ordering.
		if (this.#runnerIter !== null && !this.#consumed && !this.#terminated) {
			try {
				await this.#runnerIter.return?.();
			} catch {
				// Best-effort — cleanup errors are not actionable here.
			}
			this.#markTerminated();
		}

		// If `.columns()` was awaited but never resolved (cancel arrived
		// before metadata), reject it with the abort reason.
		if (this.#columnsResolve !== null && this.#firstColumns === null) {
			const reason = this.#ownAbortController.signal.reason;
			const err = reason instanceof Error
				? reason
				: new Error('Query was cancelled before column metadata arrived');
			this.#streamError = err;
			this.#columnsReject?.(err);
			this.#columnsResolve = null;
			this.#columnsReject = null;
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

	// Lazy-initialise the shared runner iterator + termination promise.
	// Both `.columns()`'s shape pump and `#streamEvents` go through this,
	// so the iterator is allocated exactly once per Query and the
	// termination promise is paired with its lifetime.
	#ensureRunnerIter(): AsyncIterator<ResultEvent> {
		if (this.#runnerIter !== null) return this.#runnerIter;
		this.#terminationPromise = new Promise<void>((res) => {
			this.#terminationResolve = res;
		});
		this.#runnerIter = this.#runner.run(
			this.#request,
			this.#composedSignal(),
		)[Symbol.asyncIterator]();
		return this.#runnerIter;
	}

	#markTerminated(): void {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#terminationResolve?.();
	}

	// Apply per-event side effects (trailer accumulation; first-rowset
	// columns capture). Called on every event consumed from the runner
	// regardless of which path (shape pump or row terminal) drove it.
	#observeEvent(event: ResultEvent): void {
		this.#updateTrailer(event);
		if (event.kind === 'metadata' && this.#firstColumns === null) {
			this.#firstColumns = event.columns;
			this.#columnsResolve?.(event.columns);
			this.#columnsResolve = null;
			this.#columnsReject = null;
		}
	}

	// Shape-only pump for `.columns()`. Pulls events into the lookahead
	// buffer until the FIRST metadata token (or end-of-stream / error),
	// then stops calling `iter.next()` — the iterator is left paused;
	// driver-level backpressure holds the connection until either a row
	// terminal continues consumption or `.dispose()` cancels it.
	async #runShapePump(): Promise<void> {
		const iter = this.#ensureRunnerIter();
		try {
			while (true) {
				const { value, done } = await iter.next();
				if (done) {
					// Stream ended without metadata — DML query, etc.
					if (this.#firstColumns === null) {
						this.#firstColumns = [];
						this.#columnsResolve?.([]);
						this.#columnsResolve = null;
						this.#columnsReject = null;
					}
					this.#trailer.completed = true;
					this.#markTerminated();
					return;
				}
				this.#observeEvent(value);
				this.#lookahead.push(value);
				if (value.kind === 'metadata') {
					// First metadata seen — `#observeEvent` has resolved
					// the columns promise. Stop pulling; the iterator is
					// left paused for a row terminal to resume (or for
					// `.dispose()` to release).
					return;
				}
			}
		} catch (err) {
			this.#streamError = err as Error;
			if (this.#firstColumns === null) {
				this.#columnsReject?.(err);
				this.#columnsResolve = null;
				this.#columnsReject = null;
			}
			this.#markTerminated();
		}
	}

	// Driver-stream consumer for row-consuming terminals. Drains the
	// shape-pump lookahead first (if any), then continues from the
	// shared runner iterator. Sets `#terminated` in `finally` so
	// abnormal exits (consumer break, runner error) still mark the
	// stream as terminated for `.meta()` access. `#completed` is set
	// only on natural drain.
	async *#streamEvents(): AsyncIterable<ResultEvent> {
		// 1. Wait for any in-flight shape pump to finish — it owns the
		//    iterator until then. Errors from the pump are stored on
		//    `#streamError`, not thrown here, so the shape pump's
		//    promise always settles cleanly.
		if (this.#shapePumpPromise !== null) {
			await this.#shapePumpPromise;
		}
		// 2. If no shape pump set up the runner iter / termination
		//    promise, do it now (this is the no-`columns()` fast path).
		this.#ensureRunnerIter();
		try {
			// 3. Re-throw the shape pump's stored error before yielding
			//    anything — the row terminal sees the failure exactly as
			//    if it had been consuming the stream itself.
			if (this.#streamError !== null) {
				throw this.#streamError;
			}
			// 4. Drain the lookahead buffer first so the row terminal
			//    sees events in arrival order.
			if (this.#lookahead.length > 0) {
				const buffered = this.#lookahead;
				this.#lookahead = [];
				for (const event of buffered) {
					yield event;
				}
			}
			// 5. Continue pulling from the shared iterator.
			const iter = this.#ensureRunnerIter();
			while (true) {
				const { value, done } = await iter.next();
				if (done) break;
				this.#observeEvent(value);
				yield value;
			}
			this.#trailer.completed = true;
		} catch (err) {
			// Store the error so a `.columns()` call AFTER a failed
			// terminal can settle promptly. Re-reject any pending
			// columns promise that didn't see metadata.
			this.#streamError = err as Error;
			if (this.#firstColumns === null) {
				this.#columnsReject?.(err);
				this.#columnsResolve = null;
				this.#columnsReject = null;
			}
			throw err;
		} finally {
			this.#markTerminated();
			// If `.columns()` was awaited but the stream ended without
			// metadata and without error, resolve with `[]`.
			if (
				this.#firstColumns === null
				&& this.#columnsResolve !== null
				&& this.#streamError === null
			) {
				this.#firstColumns = [];
				this.#columnsResolve([]);
				this.#columnsResolve = null;
				this.#columnsReject = null;
			}
			// Propagate cleanup to the shared runner iterator. The
			// manual `iter.next()` loop above doesn't get the automatic
			// `iter.return()` that `for await ... of` would emit on
			// abnormal exits — we have to call it ourselves so the
			// runner's `try/finally` (poolRunner's `await using pooled`
			// → release; tedious's `bridge.destroy()` → cancel-ack
			// settle) fires when the consumer breaks out of `for await`,
			// when `#consumeRows` throws (e.g. `MultipleRowsetsError`),
			// or when any downstream observer throws. Natural drain
			// exhausted the iterator already (`done: true`), so this
			// is a no-op there. Cleanup errors are swallowed — by the
			// time we're here, the consumer has already seen its
			// terminal value (returned rows, threw, or completed).
			if (this.#runnerIter !== null) {
				try {
					await this.#runnerIter.return?.();
				} catch {
					// Swallow — runner cleanup errors are not actionable
					// at this layer.
				}
			}
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
