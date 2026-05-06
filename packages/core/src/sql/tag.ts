/**
 * `sql` tagged-template factory (ADR-0006).
 *
 * Vertical-slice cut: the minimal callable form `` sql`SELECT ${id}` ``
 * that returns a {@link Query}. The user-facing extensions (`sql.unsafe`,
 * `sql.acquire`, `sql.transaction`, `sql.savepoint`, `sql.ping`) land
 * with the scope-builder runtime in a round-out commit.
 *
 * Interpolated values become parameter bindings — every `${value}` in
 * the template emits an `@p<N>` placeholder in the SQL text and a
 * matching {@link ParamBinding} entry. This is the safe-by-construction
 * property of the API: a `${userInput}` literally cannot be string-
 * interpolated into the SQL text — only bound as a parameter.
 *
 * Internal: the {@link Client} builds one `SqlTag` per scope (one for
 * the pool-bound `sql`, later one each for `ReservedConn` / `Transaction`
 * / `Savepoint` scopes) by binding to the appropriate `RequestRunner`.
 */

import type { ParamBinding } from '../driver/index.js';
import { Query } from '../query/index.js';
import type { RequestRunner } from '../query/index.js';

/**
 * The pool-bound (and, after the round-out, scope-bound) tagged-template
 * callable. Vertical-slice form — just the tag; method extensions
 * (`.unsafe`, `.acquire`, `.transaction`, `.savepoint`, `.ping`) attach
 * in later commits.
 */
export type SqlTag = <T = unknown>(
	strings: TemplateStringsArray,
	...values: unknown[]
) => Query<T>;

/**
 * Build a {@link SqlTag} bound to the given runner.
 *
 * Each tag invocation produces a fresh {@link Query} — no caching across
 * calls (each call is a distinct round-trip per ADR-0006 single-
 * consumption semantics).
 */
export function makeSqlTag(runner: RequestRunner): SqlTag {
	return function sql<T>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T> {
		const parts: string[] = [];
		const params: ParamBinding[] = [];
		for (let i = 0; i < strings.length; i++) {
			parts.push(strings[i] ?? '');
			if (i < values.length) {
				const name = `p${i}`;
				parts.push(`@${name}`);
				params.push({ name, value: values[i] });
			}
		}
		return new Query<T>({
			runner,
			request: { sql: parts.join(''), params },
		});
	};
}
