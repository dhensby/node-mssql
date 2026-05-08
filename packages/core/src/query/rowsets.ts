/**
 * `Rowsets<Tuple>` — multi-rowset terminal (ADR-0006).
 *
 * Returned by {@link Query#rowsets}. Both {@link PromiseLike} (buffered
 * tuple form) and {@link AsyncIterable} (streamed nested-iterable form);
 * the user picks consumption mode by how they consume it:
 *
 * ```ts
 * // Buffered: await yields a typed tuple of arrays
 * const [users, orders] = await q.rowsets<[User, Order]>()
 *
 * // Streamed: outer iterates rowsets, inner iterates rows
 * for await (const rowset of q.rowsets<[User, Order]>()) {
 *   for await (const row of rowset) { ... }
 * }
 * ```
 *
 * Break semantics (streamed form, ADR-0006):
 * - **Inner break.** Drains the remaining rows of the current rowset
 *   and yields the next one to the outer loop. The library reads and
 *   discards the rows the user didn't want; the request continues.
 * - **Outer break.** Cancels the underlying request via the wrapped
 *   stream's `iter.return()` chain. No further reads from the wire.
 *
 * The two forms are mutually exclusive: each `Rowsets` is single-
 * consumption (await OR iterate, not both). A second call throws
 * `TypeError`. The Query that produced this `Rowsets` is itself
 * already consumed by the moment `q.rowsets()` returned (matching the
 * single-consumption guard on `.all()` / `.iterate()` / `.run()` /
 * `.result()`).
 *
 * Internal implementation note — both forms wrap the SAME underlying
 * `AsyncIterable<ResultEvent>` (the Query's `#streamEvents()`
 * generator). The Query's trailer accumulator runs as a side effect
 * of stream observation, so trailer events flow regardless of which
 * form the user picked.
 */

import type { ColumnMetadata, ResultEvent } from '../driver/index.js';

/**
 * Map a rowset-element tuple to the buffered-await result type:
 * `[User, Order] → [User[], Order[]]`. Each tuple position becomes the
 * array of rows for that rowset.
 */
export type RowsetsAwaited<T extends readonly unknown[]> = {
	[K in keyof T]: T[K][]
};

const ROW_BEFORE_METADATA =
	'driver emitted a row event before metadata — driver bug';

const ALREADY_CONSUMED =
	'Rowsets already consumed. Each Rowsets is single-consumption — pick await OR for-await on a given Rowsets, not both. To re-consume, call .rowsets() again on a fresh Query.';

export class Rowsets<Tuple extends readonly unknown[] = readonly unknown[]> implements
	PromiseLike<RowsetsAwaited<Tuple>>,
	AsyncIterable<AsyncIterable<Tuple[number]>>
{
	readonly #stream: AsyncIterable<ResultEvent>;
	readonly #rawMode: boolean;
	#consumed = false;

	constructor(stream: AsyncIterable<ResultEvent>, rawMode: boolean) {
		this.#stream = stream;
		this.#rawMode = rawMode;
	}

	// ─── PromiseLike (buffered) ──────────────────────────────────────────

	then<R1 = RowsetsAwaited<Tuple>, R2 = never>(
		onFulfilled?: ((value: RowsetsAwaited<Tuple>) => R1 | PromiseLike<R1>) | null,
		onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
	): PromiseLike<R1 | R2> {
		return this.#buffered().then(onFulfilled, onRejected);
	}

	// ─── AsyncIterable (streamed) ────────────────────────────────────────

	[Symbol.asyncIterator](): AsyncIterator<AsyncIterable<Tuple[number]>> {
		this.#claimConsumption();
		return this.#streamed();
	}

	// ─── Internals ───────────────────────────────────────────────────────

	#claimConsumption(): void {
		if (this.#consumed) {
			throw new TypeError(ALREADY_CONSUMED);
		}
		this.#consumed = true;
	}

	async #buffered(): Promise<RowsetsAwaited<Tuple>> {
		this.#claimConsumption();
		const out: unknown[][] = [];
		let cur: unknown[] | null = null;
		let cols: readonly ColumnMetadata[] | null = null;
		const rawMode = this.#rawMode;
		for await (const event of this.#stream) {
			switch (event.kind) {
				case 'metadata':
					// Defensive — if a previous rowset never saw `rowsetEnd`,
					// flush what we have and start a fresh rowset.
					if (cur !== null) out.push(cur);
					cols = event.columns;
					cur = [];
					break;
				case 'row':
					if (cols === null || cur === null) {
						throw new Error(ROW_BEFORE_METADATA);
					}
					cur.push(rawMode ? event.values : shapeRow(event.values, cols));
					break;
				case 'rowsetEnd':
					if (cur !== null) {
						out.push(cur);
						cur = null;
						cols = null;
					}
					break;
				// Trailer events (info/print/envChange/output/returnValue/done)
				// flow through the Query's `#observeEvent` accumulator on the
				// upstream side; we don't need to handle them here.
			}
		}
		// Defensive — flush any rowset that didn't see rowsetEnd before the
		// stream ended.
		if (cur !== null) out.push(cur);
		return out as RowsetsAwaited<Tuple>;
	}

	// Streamed form. Outer iterator yields one inner iterable per rowset;
	// inner iterables yield rows until rowsetEnd. A 1-event lookahead
	// buffer lets the inner peek-without-committing for the rowset boundary.
	//
	// Outer-break: the generator's `finally` calls `streamIter.return?.()`,
	// triggering the runner's cleanup chain through the wrapped Query.
	//
	// Inner-break: the inner generator's `return()` is a no-op; on the
	// next outer pull we detect the unfinished current rowset and drain
	// its remaining row events before searching for the next metadata.
	async *#streamed(): AsyncGenerator<AsyncIterable<Tuple[number]>, void, void> {
		const streamIter = this.#stream[Symbol.asyncIterator]();
		// 1-event lookahead — shared across all iterations of the outer
		// loop. Set when an inner sees `metadata` (which belongs to the
		// next rowset) and pushes it back so the outer can pick it up on
		// its next metadata search.
		let pending: ResultEvent | null = null;
		const rawMode = this.#rawMode;

		const pullEvent = async (): Promise<ResultEvent | null> => {
			if (pending !== null) {
				const e = pending;
				pending = null;
				return e;
			}
			const result = await streamIter.next();
			return result.done ? null : result.value;
		};

		try {
			while (true) {
				// Find the next metadata token, skipping trailer events that
				// arrive between rowsets.
				let cols: readonly ColumnMetadata[] | null = null;
				while (true) {
					const ev = await pullEvent();
					if (ev === null) return;  // end of stream
					if (ev.kind === 'metadata') {
						cols = ev.columns;
						break;
					}
					// info / print / envChange / output / returnValue / done /
					// stray rowsetEnd — accumulated upstream, ignored here.
				}

				// Per-rowset boundary tracker. Declared inside the outer
				// loop so each inner iterator captures a fresh variable —
				// the previous iteration's value can't leak across rowsets.
				let rowsetEndSeen = false;
				const innerCols = cols;

				// Inner iterator — yields shaped rows for the current rowset
				// until `rowsetEnd` (or `metadata` for the next rowset, which
				// we push back). Returning from this generator is a no-op;
				// the outer drains the unfinished rowset on its next pull.
				const innerIter: AsyncIterableIterator<Tuple[number]> = {
					[Symbol.asyncIterator]() { return this; },
					async next(): Promise<IteratorResult<Tuple[number]>> {
						while (true) {
							const ev = await pullEvent();
							if (ev === null) {
								rowsetEndSeen = true;
								return { value: undefined, done: true };
							}
							if (ev.kind === 'rowsetEnd') {
								rowsetEndSeen = true;
								return { value: undefined, done: true };
							}
							if (ev.kind === 'metadata') {
								// Belongs to the next rowset — push back so
								// the outer picks it up. Treat as end of
								// current rowset (rowsetEndSeen left false
								// so the outer drain skips — there's nothing
								// more to drain in this rowset).
								pending = ev;
								rowsetEndSeen = true;
								return { value: undefined, done: true };
							}
							if (ev.kind === 'row') {
								return {
									value: rawMode
										? (ev.values as Tuple[number])
										: shapeRow<Tuple[number]>(ev.values, innerCols),
									done: false,
								};
							}
							// Trailer event — already accumulated upstream;
							// keep pulling for a row / rowsetEnd / metadata.
						}
					},
					async return(): Promise<IteratorResult<Tuple[number]>> {
						// Inner-break — outer drains on its next pull.
						return { value: undefined, done: true };
					},
				};

				yield innerIter;

				// After the consumer is done with this inner (natural end OR
				// break), drain any remaining row events of the current
				// rowset so the next outer .next() resumes at a clean
				// boundary.
				if (!rowsetEndSeen) {
					while (true) {
						const ev = await pullEvent();
						if (ev === null) return;
						if (ev.kind === 'rowsetEnd') break;
						if (ev.kind === 'metadata') {
							pending = ev;
							break;
						}
						// row / trailer — read and discard.
					}
				}
			}
		} finally {
			// Whether we reached natural end or the consumer broke out of
			// the outer loop, propagate `return()` to the wrapped stream
			// so the runner's cleanup chain (poolRunner's release;
			// tedious's bridge.destroy()) fires.
			await streamIter.return?.();
		}
	}
}

// Build an object row from a `values` tuple plus the latest column
// metadata. Last-wins on duplicate names is a natural fallout of
// object-key assignment (ADR-0007). Mirrors the helper in `query.ts`.
// Duplicated rather than imported to keep the rowsets module self-
// contained — a single 6-line function is cheaper than a cross-module
// dependency.
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
