/**
 * `ResultStream` — the result-stream collector behind `Query<T>`
 * (ADR-0006 / ADR-0007 / ADR-0008 / ADR-0023).
 *
 * Drives a {@link RequestRunner} exactly once and owns everything about
 * consuming that single event stream:
 *
 * - {@link ResultStream.events} is the one internal generator that drives
 *   the runner. It accumulates trailer data into the trailer and yields
 *   each `ResultEvent`. The `Query` handle's row terminals and `Rowsets`
 *   both consume it; trailer accumulation is automatic regardless of which
 *   consumer drives.
 * - {@link ResultStream.columns} resolves the FIRST rowset's column
 *   metadata. Called before any terminal, it runs a "shape-only pump" that
 *   pulls events into a lookahead buffer until the first metadata token,
 *   then leaves the runner iterator paused (driver-level backpressure holds
 *   the connection) until a terminal continues consumption or `cancel()`
 *   releases. Called after / concurrently with a terminal, it resolves when
 *   metadata flows through the shared stream.
 * - {@link ResultStream.meta} snapshots the trailer; {@link ResultStream.terminated}
 *   reports whether the stream has settled. The handle decides whether a
 *   read is legal (its `.meta()` throws before termination).
 * - {@link ResultStream.cancel} aborts the in-flight runner via an internal
 *   AbortController (composed with the consumer signal) and awaits the
 *   runner's full termination before resolving — load-bearing for the
 *   cancel-then-settle ordering (ADR-0023): the surrounding poolRunner's
 *   `await using pooled` disposal must not release the connection until the
 *   driver has settled the cancel response, otherwise `Connection.reset()`
 *   runs on top of an unsettled cancel.
 *
 * It yields RAW `ResultEvent`s — row shaping (object vs `.raw()` tuple) and
 * single-consumption gating live in the `Query` handle and in `Rowsets`,
 * both of which consume `events()`. The collector throws no domain errors:
 * stream errors propagate through `events()`; the public `StateError`s
 * (already-consumed / disposed / meta-before-termination) are the handle's.
 */

import type { ColumnMetadata, ExecuteRequest, ResultEvent } from '../driver/index.js';
import { withResolvers } from '../util/index.js';
import type { EnvChange, InfoMessage, QueryMeta } from './meta.js';
import type { RequestRunner } from './runner.js';

// Internal mutable trailer accumulator. Public `QueryMeta` is the readonly
// view returned from `.meta()` / `.result()` / `.run()`.
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
// allocation-free per `.meta()` call. Snapshotting would be defensive but
// the trailer is trusted internal state — once terminated, no further
// updates run.
const snapshotMeta = <O>(t: MutableTrailer): QueryMeta<O> =>
	t as unknown as QueryMeta<O>;

export class ResultStream {
	readonly #runner: RequestRunner;
	readonly #request: ExecuteRequest;
	readonly #signal: AbortSignal | undefined;

	#terminated = false;
	readonly #trailer: MutableTrailer = createTrailer();

	// Internal controller for `cancel()` to abort the in-flight runner
	// stream. Lazily allocated — a stream that never fires a terminal
	// doesn't pay for an `AbortController` it'll never use.
	#ownAbortController: AbortController | null = null;
	// Cached composite signal — the union of the consumer-supplied signal
	// and the own controller's signal. Built on first `#composedSignal()`.
	#compositeSignal: AbortSignal | undefined;

	// Resolves when the runner stream fully terminates (`#streamEvents`
	// `finally` or shape pump's end / error / cancel). `cancel()` awaits
	// this so it doesn't resolve until the runner has settled — load-bearing
	// for the connection-release ordering: the surrounding poolRunner's
	// `await using pooled` disposal must not fire until the driver has
	// settled the cancel response, otherwise `Connection.reset()` runs on
	// top of an unsettled cancel.
	#terminationPromise: Promise<void> | null = null;
	#terminationResolve: (() => void) | null = null;

	// Single shared runner iterator — both the shape-only pump (for
	// `columns()`) and the row-terminal stream consumer pull from this.
	// Lazy-init on first pull.
	#runnerIter: AsyncIterator<ResultEvent> | null = null;

	// Events pulled by the shape-only pump (when `columns()` runs alone) but
	// not yet handed to a terminal. The terminal drains this before
	// continuing from `#runnerIter`.
	#lookahead: ResultEvent[] = [];

	// Stored stream-level error. The shape-only pump catches errors here so
	// a terminal called later can re-throw them. Also set by `#streamEvents`'s
	// catch so a `columns()` call after a failed terminal can reject promptly.
	#streamError: Error | null = null;

	// Shape pump's run promise — non-null while it's in flight or after it
	// has settled. Terminals await this so the lookahead is fully populated
	// before they drain.
	#shapePumpPromise: Promise<void> | null = null;

	// Captured-once first-rowset columns. Returned by `columns()` and
	// resolved internally by `#observeEvent` when metadata arrives during
	// normal terminal consumption.
	#firstColumns: readonly ColumnMetadata[] | null = null;
	#columnsPromise: Promise<readonly ColumnMetadata[]> | null = null;
	#columnsResolve: ((cols: readonly ColumnMetadata[]) => void) | null = null;
	#columnsReject: ((err: unknown) => void) | null = null;

	// Set the moment a terminal claims the stream (`events()` called). Tells
	// `columns()` whether a terminal is already driving — if so it waits for
	// that consumer to observe metadata instead of starting a shape pump.
	#consuming = false;

	constructor(runner: RequestRunner, request: ExecuteRequest, signal?: AbortSignal) {
		this.#runner = runner;
		this.#request = request;
		this.#signal = signal;
	}

	get terminated(): boolean {
		return this.#terminated;
	}

	// Snapshot the accumulated trailer. The handle gates legality (its
	// public `.meta()` throws before termination); this is the raw read.
	meta<O = Record<string, never>>(): QueryMeta<O> {
		return snapshotMeta<O>(this.#trailer);
	}

	/**
	 * The single consuming drive. Marks the stream terminal-consumed
	 * synchronously — so a racing {@link ResultStream.columns} sees a
	 * terminal is driving and waits for it rather than starting a shape pump
	 * — and returns the event generator. Called at most once: the handle's
	 * single-consumption gate ensures only one terminal drives.
	 */
	events(): AsyncIterable<ResultEvent> {
		this.#consuming = true;
		return this.#streamEvents();
	}

	/**
	 * Resolve the column metadata for the FIRST rowset (ADR-0007).
	 *
	 * Locked to the first rowset — multiple calls return the same Promise.
	 * If a terminal is already driving, the returned Promise resolves when
	 * metadata flows through the shared stream (or immediately if seen). If
	 * not, this kicks off a "shape-only pump" that pulls events until the
	 * first metadata token, then pauses the runner iterator — driver-level
	 * backpressure holds the connection until either a terminal continues
	 * consumption or `cancel()` releases.
	 *
	 * Resolves to `[]` if the stream ends without metadata (e.g. pure DML);
	 * rejects with the stream error if it errors before metadata. The
	 * disposed-Query check lives in the handle.
	 */
	columns(): Promise<readonly ColumnMetadata[]> {
		// Already-resolved fast path.
		if (this.#firstColumns !== null) {
			return Promise.resolve(this.#firstColumns);
		}
		// Cached pending promise.
		if (this.#columnsPromise !== null) {
			return this.#columnsPromise;
		}
		// Stream already terminated without metadata — settle synchronously.
		// Either a terminal drained without ever seeing metadata (resolve [])
		// or it errored before metadata (reject with the error).
		if (this.#terminated) {
			if (this.#streamError !== null) {
				return Promise.reject(this.#streamError);
			}
			this.#firstColumns = [];
			return Promise.resolve(this.#firstColumns);
		}
		// Set up the pending Promise and (if no terminal is driving) kick off
		// the shape-only pump.
		const { promise, resolve, reject } = withResolvers<readonly ColumnMetadata[]>();
		this.#columnsPromise = promise;
		this.#columnsResolve = resolve;
		this.#columnsReject = reject;
		if (!this.#consuming && this.#shapePumpPromise === null) {
			this.#shapePumpPromise = this.#runShapePump();
		}
		return this.#columnsPromise;
	}

	/**
	 * Abort the in-flight stream (or pre-arm the abort if no terminal has
	 * driven yet — the next `events()` sees an already-aborted signal). The
	 * handle's `.cancel()` / `.dispose()` both route here.
	 *
	 * Awaits full runner-stream termination before resolving — load-bearing
	 * for the cancel-then-settle ordering (see the class doc). Idempotent.
	 */
	async cancel(): Promise<void> {
		if (this.#ownAbortController === null) {
			this.#ownAbortController = new AbortController();
		}
		if (!this.#ownAbortController.signal.aborted) {
			this.#ownAbortController.abort();
		}

		// Shape-only path: a `columns()` shape pump has paused the runner
		// iterator and there's no terminal consuming. The signal abort alone
		// won't wake the suspended runner generator (it's parked at `yield`,
		// not awaiting events.on). Call `iter.return()` to abruptly terminate
		// the generator and trigger its cleanup chain (poolRunner's `await
		// using pooled` → release; tedious's bridge.destroy() → cancel-ack
		// wait). The `await` is load-bearing for the cancel-then-settle order.
		if (this.#runnerIter !== null && !this.#consuming && !this.#terminated) {
			try {
				await this.#runnerIter.return?.();
			} catch {
				// Best-effort — cleanup errors are not actionable here.
			}
			this.#markTerminated();
		}

		// If `columns()` was awaited but never resolved (cancel arrived before
		// metadata), reject it with the abort reason.
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

		// Await full runner-stream termination if a stream is in flight. This
		// is load-bearing — without the wait, the surrounding poolRunner's
		// `await using pooled` disposal would fire while the runner is still
		// settling (e.g. tedious mid-cancel-response), and `Connection.reset()`
		// would corrupt the connection for the next acquire. See ADR-0023's
		// cancel-then-settle ordering.
		if (this.#terminationPromise !== null && !this.#terminated) {
			await this.#terminationPromise;
		}
	}

	// ─── Internal: shared stream consumption + trailer accumulation ──────

	// Composite signal for the runner — union of the consumer-supplied
	// signal and our own controller. Either source firing aborts the runner.
	// Lazily built on first stream start.
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

	// Lazy-initialise the shared runner iterator + termination promise. Both
	// the shape pump and `#streamEvents` go through this, so the iterator is
	// allocated exactly once and the termination promise is paired with its
	// lifetime.
	#ensureRunnerIter(): AsyncIterator<ResultEvent> {
		if (this.#runnerIter !== null) return this.#runnerIter;
		const { promise, resolve } = withResolvers<void>();
		this.#terminationPromise = promise;
		this.#terminationResolve = resolve;
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
	// regardless of which path (shape pump or terminal) drove it.
	#observeEvent(event: ResultEvent): void {
		this.#updateTrailer(event);
		if (event.kind === 'metadata' && this.#firstColumns === null) {
			this.#firstColumns = event.columns;
			this.#columnsResolve?.(event.columns);
			this.#columnsResolve = null;
			this.#columnsReject = null;
		}
	}

	// Shape-only pump for `columns()`. Pulls events into the lookahead buffer
	// until the FIRST metadata token (or end-of-stream / error), then stops
	// calling `iter.next()` — the iterator is left paused; driver-level
	// backpressure holds the connection until either a terminal continues
	// consumption or `cancel()` releases it.
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
					// First metadata seen — `#observeEvent` has resolved the
					// columns promise. Stop pulling; the iterator is left paused
					// for a terminal to resume (or for `cancel()` to release).
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

	// Driver-stream consumer. Drains the shape-pump lookahead first (if any),
	// then continues from the shared runner iterator. Sets `#terminated` in
	// `finally` so abnormal exits (consumer break, runner error) still mark
	// the stream terminated for `.meta()` access. `completed` is set only on
	// natural drain.
	async *#streamEvents(): AsyncIterable<ResultEvent> {
		// 1. Wait for any in-flight shape pump to finish — it owns the
		//    iterator until then. Errors from the pump are stored on
		//    `#streamError`, not thrown here, so the pump's promise always
		//    settles cleanly.
		if (this.#shapePumpPromise !== null) {
			await this.#shapePumpPromise;
		}
		// 2. If no shape pump set up the runner iter / termination promise,
		//    do it now (the no-`columns()` fast path).
		this.#ensureRunnerIter();
		try {
			// 3. Re-throw the shape pump's stored error before yielding
			//    anything — the terminal sees the failure exactly as if it had
			//    been consuming the stream itself.
			if (this.#streamError !== null) {
				throw this.#streamError;
			}
			// 4. Drain the lookahead buffer first so the terminal sees events
			//    in arrival order.
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
			// Store the error so a `columns()` call AFTER a failed terminal can
			// settle promptly. Re-reject any pending columns promise that
			// didn't see metadata.
			this.#streamError = err as Error;
			if (this.#firstColumns === null) {
				this.#columnsReject?.(err);
				this.#columnsResolve = null;
				this.#columnsReject = null;
			}
			throw err;
		} finally {
			this.#markTerminated();
			// If `columns()` was awaited but the stream ended without metadata
			// and without error, resolve with `[]`.
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
			// Propagate cleanup to the shared runner iterator. The manual
			// `iter.next()` loop above doesn't get the automatic `iter.return()`
			// that `for await ... of` would emit on abnormal exits — we call it
			// ourselves so the runner's `try/finally` (poolRunner's `await using
			// pooled` → release; tedious's `bridge.destroy()` → cancel-ack
			// settle) fires when the consumer breaks out of `for await`, when
			// the row layer throws (e.g. `MultipleRowsetsError`), or when any
			// downstream observer throws. Natural drain exhausted the iterator
			// already (`done: true`), so this is a no-op there. Cleanup errors
			// are swallowed — by the time we're here, the consumer has already
			// seen its terminal value (returned rows, threw, or completed).
			if (this.#runnerIter !== null) {
				try {
					await this.#runnerIter.return?.();
				} catch {
					// Swallow — runner cleanup errors are not actionable here.
				}
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
