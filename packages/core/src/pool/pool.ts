/**
 * Pool port (ADR-0011).
 *
 * Types-only at v13.0 — enough to let adapters (`@tediousjs/mssql-tarn`,
 * core's own `SingleConnectionPool`) and third-party packages type-check
 * against the shape. Runtime (`SingleConnectionPool`) lands with the
 * Queryable kernel (ADR-0006).
 */

import type { Connection } from '../driver/index.js'

export type PoolState = 'open' | 'draining' | 'destroyed'

export interface PooledConnection extends AsyncDisposable {
	readonly connection: Connection
	release(): Promise<void>
	destroy(): Promise<void>
}

export interface Pool {
	readonly state: PoolState
	acquire(signal?: AbortSignal): Promise<PooledConnection>
	drain(): Promise<void>
	destroy(): Promise<void>
}
