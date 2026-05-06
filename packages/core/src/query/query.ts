/**
 * `Query<T>` — vertical-slice scope (ADR-0006 / ADR-0007 / ADR-0008).
 *
 * Phase-1 cut: only what's needed for `await sql\`SELECT ...\`` to work
 * end-to-end. The class is `PromiseLike<T[]>` (so `await` works) backed by
 * an internal `.all()` terminal that drains the runner's `ResultEvent`
 * stream into object-shaped rows, last-wins on duplicate column names per
 * ADR-0007. Single-consumption is enforced — a second terminal call on
 * the same `Query` throws `TypeError`.
 *
 * Deferred to round-out commits: `.iterate` / `.run` / `.result` /
 * `.raw` / `.columns` / `.meta` / `.cancel` / `.dispose` / `.rowsets`,
 * `AsyncIterable` and `AsyncDisposable` surfaces, full trailer
 * accumulation, AbortSignal composition for `.cancel()`. The shape of
 * `.all()` here is the load-bearing primitive everything else extends.
 */

import type { ColumnMetadata, ExecuteRequest } from '../driver/index.js';
import { MultipleRowsetsError } from '../errors/index.js';
import type { RequestRunner } from './runner.js';

export interface QueryOptions {
	readonly runner: RequestRunner
	readonly request: ExecuteRequest
	readonly signal?: AbortSignal
}

export class Query<T = unknown> implements PromiseLike<T[]> {
	readonly #runner: RequestRunner;
	readonly #request: ExecuteRequest;
	readonly #signal: AbortSignal | undefined;

	// Single-consumption guard — flips on the first terminal call. The
	// fuller state machine (`pending` / `running` / `ended` / `cancelled`
	// / `disposed`) lands with the rest of the terminals + `.dispose()`.
	#consumed = false;

	constructor(options: QueryOptions) {
		this.#runner = options.runner;
		this.#request = options.request;
		this.#signal = options.signal;
	}

	/**
	 * PromiseLike protocol — delegates to {@link Query.all}.
	 *
	 * `await query` is the most common usage; this thenable hook is what
	 * makes it work without an explicit `.all()` call. Each `.then()` /
	 * `await` consumes the query (single-consumption guard).
	 */
	then<R1 = T[], R2 = never>(
		onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
		onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
	): PromiseLike<R1 | R2> {
		return this.all().then(onFulfilled, onRejected);
	}

	/**
	 * Drain the stream and return rows as objects.
	 *
	 * Single-rowset terminal: throws {@link MultipleRowsetsError} if the
	 * server emits a second metadata token (a second `SELECT` inside the
	 * request). Use `.rowsets()` for multi-rowset queries (lands in a
	 * round-out commit).
	 *
	 * Object shape: keys are column names from the first metadata token.
	 * On duplicate column names (e.g. `SELECT a.id, b.id FROM ...`) the
	 * later column overwrites the earlier — last-wins matches the
	 * pg / mysql2 / ORM ecosystem (ADR-0007). `.raw()` will be the
	 * preservation path when it lands.
	 */
	async all(): Promise<T[]> {
		if (this.#consumed) {
			throw new TypeError(
				'Query already consumed. Each Query<T> is single-consumption; build a new Query (call the tag again) to re-run.',
			);
		}
		this.#consumed = true;

		const rows: T[] = [];
		let columns: readonly ColumnMetadata[] | null = null;
		let firstRowsetEnded = false;

		for await (const event of this.#runner.run(this.#request, this.#signal)) {
			switch (event.kind) {
				case 'metadata':
					if (firstRowsetEnded) {
						throw new MultipleRowsetsError(
							'query produced multiple rowsets; use .rowsets() to consume them',
						);
					}
					columns = event.columns;
					break;
				case 'row':
					if (columns === null) {
						throw new Error(
							'driver emitted a row event before metadata — driver bug',
						);
					}
					rows.push(shapeRow<T>(event.values, columns));
					break;
				case 'rowsetEnd':
					firstRowsetEnded = true;
					break;
				// V-1 deliberately ignores `output`, `returnValue`, `info`,
				// `print`, `envChange` — trailer accumulation lands with `.meta()`.
				// `done` ends the loop naturally.
			}
		}

		return rows;
	}
}

// Build an object row from a `ResultEvent.values` tuple plus the latest
// column metadata. Last-wins on duplicate names is a natural fallout of
// object-key assignment.
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
