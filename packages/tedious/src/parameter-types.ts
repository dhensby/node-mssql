/**
 * Vertical-slice parameter type inference (V-3).
 *
 * Maps the JS value of a `ParamBinding` to a tedious `TYPES.<X>` constant
 * + the value to pass into `request.addParameter(name, type, value)`.
 *
 * This is intentionally minimal — just enough to land `SELECT 1`,
 * `SELECT @p` for integers / strings / a few other primitives, and
 * `null` round-trips. The proper SqlType<T> system from ADR-0019 lands
 * in a round-out commit and replaces this file; user-supplied
 * `sql.typed(value, type)` is its main entry point.
 */

import { TYPES } from 'tedious';

// `DataType` is not re-exported from `tedious`'s main entry, so we
// derive it structurally from the published `TYPES` object — every value
// matches the same `DataType` interface from `tedious/lib/data-type`.
type TediousDataType = typeof TYPES[keyof typeof TYPES];

export interface InferredParameter {
	readonly type: TediousDataType
	readonly value: unknown
}

const INT32_MAX = 2_147_483_647;

/**
 * Infer a tedious type from a JS value. Throws for unsupported types
 * with a pointer to ADR-0019 (the proper type system that's still
 * deferred).
 */
export function inferParameterType(value: unknown): InferredParameter {
	if (value === null || value === undefined) {
		// tedious has no `Null` type; using NVarChar with `null` gives a
		// typed-NULL on the wire. Round-out's typed-NULL story (per
		// ADR-0019 open questions) will refine this.
		return { type: TYPES.NVarChar, value: null };
	}
	if (typeof value === 'string') {
		return { type: TYPES.NVarChar, value };
	}
	if (typeof value === 'bigint') {
		return { type: TYPES.BigInt, value };
	}
	if (typeof value === 'number') {
		// Safe-int range fits Int (32-bit signed); larger / fractional
		// values become Float. ADR-0019 will pin precision-aware
		// inference; this is a stop-gap.
		if (Number.isInteger(value) && Math.abs(value) <= INT32_MAX) {
			return { type: TYPES.Int, value };
		}
		return { type: TYPES.Float, value };
	}
	if (typeof value === 'boolean') {
		return { type: TYPES.Bit, value };
	}
	if (value instanceof Date) {
		return { type: TYPES.DateTime2, value };
	}
	if (value instanceof Uint8Array) {
		return { type: TYPES.VarBinary, value };
	}
	throw new TypeError(
		`cannot infer SQL type for parameter value of JS type '${typeof value}'. ` +
			`The proper SqlType<T> system (ADR-0019) lands in a round-out commit; ` +
			`for now, use one of: string, number, bigint, boolean, Date, Uint8Array, null/undefined.`,
	);
}
