/**
 * Forward-declared request/response types for the Driver port (ADR-0010).
 *
 * These are intentionally minimal at v13.0 — enough to type-check the Driver
 * / Connection surface, not yet the full encoding a driver adapter needs.
 * Shapes are pinned when the first real driver (`@tediousjs/mssql-tedious`)
 * encodes against them.
 */

export interface ParamBinding {
	readonly name?: string
	readonly value: unknown
}

export interface ExecuteRequest {
	readonly sql: string
	readonly params?: readonly ParamBinding[]
	readonly kind?: 'batch' | 'rpc'
}

/**
 * Transaction isolation levels (ADR-0006). Strict lowercase strings —
 * other casings (e.g. .NET-style `'ReadCommitted'`) are rejected at the
 * type level; runtime validation is the driver's responsibility for
 * dynamically-built strings that bypass the literal type.
 *
 * SNAPSHOT requires `ALLOW_SNAPSHOT_ISOLATION ON` at the database level;
 * the library does not validate this — SQL Server raises an error if
 * it is off.
 */
export type IsolationLevel =
	| 'read uncommitted'
	| 'read committed'
	| 'repeatable read'
	| 'snapshot'
	| 'serializable';

export interface TxOptions {
	readonly isolationLevel?: IsolationLevel
	readonly name?: string
}

export interface PrepareRequest {
	readonly sql: string
	readonly params?: readonly ParamBinding[]
}

export interface PreparedHandle {
	readonly id: string
}

export interface BulkOptions {
	readonly table: string
	readonly rows: AsyncIterable<readonly unknown[]>
}

export interface BulkResult {
	readonly rowsAffected: number
}
