/**
 * Trailer-data shapes carried by `Query<T>` (ADR-0007).
 *
 * Every server response carries trailer data alongside rows — per-statement
 * row counts, info / print / envchange messages, procedure output
 * parameters, and a return status. This trailer is the same regardless of
 * which terminal consumed the rowset(s); `Query<T>.meta()` (sync getter,
 * post-drain) exposes it uniformly. Cross-cutting consumers reach for
 * `diagnostics_channel` instead.
 *
 * Phase-1 vertical slice: types declared, populated minimally by `.all()`
 * (which doesn't yet expose them through a public `.meta()`). Full meta
 * accumulation lands with the rest of the single-rowset terminals.
 */

import type { EnvChangeType } from '../driver/index.js';

export interface InfoMessage {
	readonly number: number
	readonly state: number
	readonly class: number
	readonly message: string
	readonly serverName?: string
	readonly procName?: string
	readonly lineNumber?: number
}

export interface EnvChange {
	readonly type: EnvChangeType
	readonly oldValue: string
	readonly newValue: string
}

export interface QueryMeta<O = Record<string, never>> {
	readonly rowsAffected: number
	readonly rowsAffectedPerStatement: readonly number[]
	readonly info: readonly InfoMessage[]
	readonly print: readonly string[]
	readonly envChanges: readonly EnvChange[]
	readonly output: O
	readonly returnValue: number | undefined
	// `true` if the stream drained naturally; `false` on abort / cancel /
	// dispose / error.
	readonly completed: boolean
}
