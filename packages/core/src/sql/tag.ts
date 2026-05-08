/**
 * `sql` tagged-template factory (ADR-0006).
 *
 * The base `SqlTag` is the callable + `.unsafe(text, params?)` raw-text
 * escape hatch — the pieces present on EVERY scope (pool-bound, reserved
 * connection, transaction, savepoint). Scope-specific surface
 * (`.acquire`, `.transaction`, `.savepoint`, `.ping`) attaches at the
 * scope layer above this module, not here.
 *
 * Tagged-template form: every `${value}` in the template emits an
 * `@p<N>` placeholder in the SQL text and a matching {@link ParamBinding}
 * entry. This is the safe-by-construction property of the API — a
 * `${userInput}` literally cannot be string-interpolated into the SQL
 * text, only bound as a parameter.
 *
 * Raw-text form (`.unsafe`): runs SQL the library did not author —
 * query-builder output, external migration tooling, etc. The `unsafe`
 * name is the warning; `grep -r "sql\.unsafe"` finds every escape-hatch
 * call site in one pass. Parameters bind on the wire identically to the
 * tagged form; only the text is raw.
 *
 * Internal: the {@link Client} builds one `SqlTag` per scope (the pool-
 * bound `sql`; later one each for `ReservedConn` / `Transaction` /
 * `Savepoint` scopes) by binding to the appropriate `RequestRunner`.
 */

import type { ParamBinding } from '../driver/index.js';
import { Query } from '../query/index.js';
import type { RequestRunner } from '../query/index.js';

/**
 * Parameter input shapes accepted by {@link SqlTag.unsafe}.
 *
 * - `Record<string, unknown>` binds by name — the keys become parameter
 *   names verbatim. The text refers to them as `@<name>`.
 * - `readonly unknown[]` binds positionally — index `i` becomes `p<i>`,
 *   matching the convention the tagged-template form emits. The text
 *   refers to them as `@p0` / `@p1` / …, so a builder that emits the
 *   library's positional placeholders feeds straight in.
 *
 * Other shapes (Map, custom iterables, …) are not accepted — the binding
 * machine validates positional vs named at the parameter type level
 * (ADR-0019), and accepting more shapes here would push the validation
 * deeper without buying anything users can't get with one of these two.
 */
export type UnsafeParams = Record<string, unknown> | readonly unknown[];

/**
 * The base scoped tag — callable plus the raw-text escape hatch. Every
 * scope (pool-bound, ReservedConn, Transaction, Savepoint) extends this.
 */
export interface SqlTag {
	<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Query<T>
	unsafe<T = unknown>(text: string, params?: UnsafeParams): Query<T>
}

/**
 * Build a {@link SqlTag} bound to the given runner.
 *
 * Each tag invocation produces a fresh {@link Query} — no caching across
 * calls (each call is a distinct round-trip per ADR-0006 single-
 * consumption semantics).
 */
export function makeSqlTag(runner: RequestRunner): SqlTag {
	function sql<T>(
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
	}

	function unsafe<T>(text: string, params?: UnsafeParams): Query<T> {
		const bindings: ParamBinding[] = [];
		if (params !== undefined) {
			if (Array.isArray(params)) {
				// Positional: index `i` → `p<i>`. Mirrors the tag's
				// generated names so a builder emitting `@p0 / @p1 / …`
				// feeds straight in.
				for (let i = 0; i < params.length; i++) {
					bindings.push({ name: `p${i}`, value: params[i] });
				}
			} else {
				// Named: keys become parameter names verbatim.
				for (const [name, value] of Object.entries(params)) {
					bindings.push({ name, value });
				}
			}
		}
		return new Query<T>({
			runner,
			request: { sql: text, params: bindings },
		});
	}

	// Attach `unsafe` to the callable. The cast is the standard
	// pattern for callable-with-properties — the resulting object's
	// signature matches `SqlTag` exactly.
	const tag = sql as SqlTag;
	tag.unsafe = unsafe;
	return tag;
}
