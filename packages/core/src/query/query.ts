/**
 * `Query<T>` — the single-rowset query handle (ADR-0006 / ADR-0007 / ADR-0008).
 *
 * The lazy, single-consumption object the `sql` tag returns. It is a thin
 * handle over a {@link ResultStream} (the result-stream collector): the
 * handle owns the public contract — the terminal surface, the single-
 * consumption gate, `.raw()` view toggling, and row shaping (object vs
 * positional tuple) — and delegates the stream lifecycle (driving the
 * runner, trailer accumulation, the `.columns()` shape pump, termination,
 * cancellation) to the collector, allocated lazily on first use. A handle
 * whose terminal never fires never allocates a collector or touches the
 * runner.
 *
 * Terminals (single-consumption, enforced once via `#consumed`):
 * - Row-consuming (`all` / `iterate` / `result`, plus the `await` and
 *   `for await` sugar) share {@link Query#consumeRows}, which shapes rows
 *   and throws {@link MultipleRowsetsError} on a second rowset.
 * - Drain-only (`run`) consumes the collector's events directly, oblivious
 *   to rows and rowset boundaries (ADR-0006).
 * - Multi-rowset (`rowsets`) hands the collector's event stream to
 *   {@link Rowsets}.
 *
 * Non-consuming: `.raw()` (a builder — returns a fresh handle), `.columns()`
 * (first-rowset shape, delegated to the collector), and `.meta()` (a trailer
 * snapshot; throws {@link StateError} before the stream terminates).
 */

import type { ColumnMetadata, ExecuteRequest, ResultEvent } from '../driver/index.js';
import { MultipleRowsetsError, StateError } from '../errors/index.js';
import type { QueryMeta } from './meta.js';
import { ResultStream } from './result-stream.js';
import { Rowsets } from './rowsets.js';
import type { RequestRunner } from './runner.js';

export interface QueryOptions {
	readonly runner: RequestRunner
	readonly request: ExecuteRequest
	readonly signal?: AbortSignal
	// View-toggle flag set by `.raw()`. Internal — users access this path
	// via `query.raw()`, never directly.
	readonly rawMode?: boolean
}

const ALREADY_CONSUMED =
	'Query already consumed. Each Query<T> is single-consumption; build a new Query (call the tag again) to re-run.';

const DISPOSED =
	'Query has been disposed. Calling a terminal on a disposed Query is not allowed.';

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
	#disposed = false;

	// The result-stream collector — created lazily on the first terminal,
	// `.columns()`, or `.cancel()` / `.dispose()`. Null until then so a
	// handle that never runs costs nothing beyond its config.
	#stream: ResultStream | null = null;

	constructor(options: QueryOptions) {
		this.#runner = options.runner;
		this.#request = options.request;
		this.#signal = options.signal;
		this.#rawMode = options.rawMode ?? false;
	}

	// ─── PromiseLike ──────────────────────────────────────────────────────

	/**
	 * `await query` is the most common consumption shape; this thenable hook
	 * makes it work without an explicit `.all()` call. Each `await` counts as
	 * a single consumption — a second `await` on the same `Query` rejects via
	 * `.all()`'s single-consumption guard.
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
	 * Single-rowset terminal: throws {@link MultipleRowsetsError} if a second
	 * metadata token arrives. Use `.rowsets()` for multi-rowset queries.
	 */
	async all(): Promise<T[]> {
		this.#claimConsumption();
		const events = this.#ensureStream().events();
		const rows: T[] = [];
		for await (const row of this.#consumeRows(events)) {
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
	 * which propagates through the collector to the runner — for pool-bound
	 * runners that cancels the in-flight request and releases the connection
	 * (per ADR-0008).
	 */
	iterate(): AsyncIterableIterator<T> {
		this.#claimConsumption();
		return this.#consumeRows(this.#ensureStream().events());
	}

	/**
	 * Drain the stream without buffering rows; returns the trailer.
	 *
	 * Drain-only paths are intentionally oblivious to rowset boundaries
	 * (ADR-0006) — `.run()` does NOT throw `MultipleRowsetsError` if the
	 * statement produces multiple rowsets. Use it for DML where you only care
	 * about row counts / output params, or when you want to drain a statement
	 * without paying the cost of buffering rows.
	 */
	async run<O = Record<string, never>>(): Promise<QueryMeta<O>> {
		this.#claimConsumption();
		const stream = this.#ensureStream();
		for await (const _event of stream.events()) {
			// Drain. Trailer is accumulated by the collector itself.
		}
		return stream.meta<O>();
	}

	/**
	 * Buffer all rows AND return the trailer in a single shape. Inline-
	 * friendly for DML with `OUTPUT` and procedures whose `output` parameters
	 * are wanted alongside rows. Equivalent to `.all()` + `.meta()` but avoids
	 * holding the Query reference for two calls (ADR-0006).
	 */
	async result<O = Record<string, never>>(): Promise<{
		rows: T[]
		meta: QueryMeta<O>
	}> {
		this.#claimConsumption();
		const stream = this.#ensureStream();
		const rows: T[] = [];
		for await (const row of this.#consumeRows(stream.events())) {
			rows.push(row);
		}
		return { rows, meta: stream.meta<O>() };
	}

	// ─── Multi-rowset terminal ───────────────────────────────────────────

	/**
	 * Multi-rowset terminal — returns a {@link Rowsets} that is BOTH thenable
	 * and async-iterable (ADR-0006). The user picks consumption mode by how
	 * they consume it:
	 *
	 * ```ts
	 * // Buffered (awaited): tuple of arrays
	 * const [users, orders] = await q.rowsets<[User, Order]>()
	 *
	 * // Streamed (iterated): nested AsyncIterable per rowset
	 * for await (const rowset of q.rowsets<[User, Order]>()) {
	 *   for await (const row of rowset) { ... }
	 * }
	 * ```
	 *
	 * The returned `Rowsets` is itself single-consumption: pick await OR
	 * for-await on a given `Rowsets`, not both. Calling `.rowsets()` consumes
	 * this `Query<T>` (matching the other row-consuming terminals) — call the
	 * tag again to re-run the SQL.
	 *
	 * Trailer accumulation runs on the underlying stream regardless of which
	 * form is consumed; `.meta()` reflects per-rowset `rowsAffected` after
	 * termination just as it would for `.run()`.
	 *
	 * `.raw()` mode is honoured: the awaited form returns
	 * `RowsetsAwaited<Tuple>` of positional tuples; the streamed inner yields
	 * the same.
	 */
	rowsets<Tuple extends readonly unknown[] = readonly unknown[]>(): Rowsets<Tuple> {
		this.#claimConsumption();
		return new Rowsets<Tuple>(this.#ensureStream().events(), this.#rawMode);
	}

	// ─── View toggle (non-consuming) ─────────────────────────────────────

	/**
	 * View toggle to a positional-tuple row shape (ADR-0007).
	 *
	 * Returns a NEW `Query<R>` whose row-consuming terminals yield rows as
	 * `R` (a positional tuple) instead of objects. Each value lands at the
	 * index reported by `.columns()`, preserving duplicate column values that
	 * the default object shape collapses last-wins.
	 *
	 * `.raw()` does NOT consume the original Query — it's a builder, not a
	 * terminal (per ADR-0007 / ADR-0006). Each call returns a fresh `Query`,
	 * and execution starts only when a terminal fires on the returned Query
	 * (lazy). The original Query remains independently consumable; calling its
	 * terminals runs a separate round-trip.
	 *
	 * Tuple element type defaults to `unknown[]`; callers narrow with a tuple
	 * type argument: `q.raw<[number, string]>()`.
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
	 * Non-consuming and locked to the first rowset — repeat calls return the
	 * same Promise. Delegates to the collector, which resolves the columns
	 * either from a running terminal's stream observation or, if no terminal
	 * has fired, from a "shape-only pump" that pulls events until the first
	 * metadata token and then pauses the runner (see {@link ResultStream.columns}).
	 *
	 * Edge cases: resolves to `[]` for a query with no rowsets (pure DML);
	 * rejects with the stream error if it errors before metadata; rejects with
	 * `StateError` on a disposed Query.
	 */
	columns(): Promise<readonly ColumnMetadata[]> {
		if (this.#disposed) {
			return Promise.reject(new StateError(DISPOSED));
		}
		return this.#ensureStream().columns();
	}

	// ─── Trailer access (non-consuming) ──────────────────────────────────

	/**
	 * Synchronous accessor for trailer data — row counts, info / print /
	 * envChange messages, output parameters, return status. Throws
	 * `StateError` if the stream hasn't yet terminated; the natural sequence
	 * is to await a row-consuming terminal first, then read `.meta()`.
	 *
	 * On non-natural exit (`break` from `for await`, signal abort, error
	 * mid-stream), the stream still terminates and `.meta()` returns the
	 * trailer accumulated up to that point with `completed: false`.
	 */
	meta<O = Record<string, never>>(): QueryMeta<O> {
		if (this.#stream === null || !this.#stream.terminated) {
			throw new StateError(META_BEFORE_TERMINATION);
		}
		return this.#stream.meta<O>();
	}

	// ─── Cancellation & disposal ─────────────────────────────────────────

	/**
	 * Issue a driver-level cancel for the in-flight stream (or pre-arm the
	 * cancellation if no terminal has fired yet — the next terminal call sees
	 * an already-aborted signal and rejects).
	 *
	 * Same effect as `.dispose()` on an in-flight stream — both abort the
	 * underlying runner via `AbortSignal`. Differs in that `.cancel()` doesn't
	 * mark the Query as disposed: subsequent `.meta()` calls return the
	 * partial trailer (with `completed: false`), and `.cancel()` is idempotent.
	 */
	async cancel(): Promise<void> {
		await this.#ensureStream().cancel();
	}

	/**
	 * `await using` resource cleanup — cancels any in-flight stream and marks
	 * the Query as disposed. Subsequent terminal calls throw `StateError`.
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

	// ─── Internal ────────────────────────────────────────────────────────

	#claimConsumption(): void {
		if (this.#disposed) {
			throw new StateError(DISPOSED);
		}
		if (this.#consumed) {
			throw new StateError(ALREADY_CONSUMED);
		}
		this.#consumed = true;
	}

	// Lazy-allocate the result-stream collector. Shared by the terminals,
	// `.columns()`, and `.cancel()` so a Query drives at most one runner
	// stream across all of them.
	#ensureStream(): ResultStream {
		return (this.#stream ??= new ResultStream(this.#runner, this.#request, this.#signal));
	}

	// Row-consuming layer over the collector's event stream. Yields shaped
	// rows. Throws `MultipleRowsetsError` if a second metadata token arrives —
	// ADR-0006's "row-promising terminals" contract.
	async *#consumeRows(events: AsyncIterable<ResultEvent>): AsyncIterableIterator<T> {
		let firstRowsetEnded = false;
		let columns: readonly ColumnMetadata[] | null = null;
		for await (const event of events) {
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
				// envChange) are accumulated by the collector via stream
				// observation; this layer doesn't need to react. `done` is the
				// natural-end marker — also a no-op here.
			}
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
