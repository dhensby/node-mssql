/**
 * Pool port (ADR-0011).
 *
 * Types-only at v13.0 — enough to let adapters (`@tediousjs/mssql-tarn`,
 * core's own no-pool short-circuit `SingleConnection`) and third-party
 * packages type-check against the shape. Runtime (`SingleConnection`)
 * lands with the Queryable kernel (ADR-0006).
 */

import type { Connection } from '../driver/index.js';

export type PoolState = 'open' | 'draining' | 'destroyed';

// Polled snapshot of pool gauges. Adapters with no meaningful "pending"
// concept report whatever count corresponds to their internal model;
// adapters that grow on demand (no pre-allocation) report current size,
// not a max. Also surfaced on `mssql:pool:acquire` / `:release`
// diagnostics-channel events as the `stats` field (ADR-0014).
export interface PoolStats {
	readonly size: number       // total connections currently held (idle + in-use)
	readonly available: number  // idle connections immediately available for acquire
	readonly inUse: number      // connections currently checked out
	readonly pending: number    // acquire requests waiting for a connection
}

export interface PooledConnection extends AsyncDisposable {
	readonly connection: Connection
	release(): Promise<void>
	destroy(): Promise<void>
}

export interface Pool {
	readonly state: PoolState
	readonly stats: PoolStats
	acquire(signal?: AbortSignal): Promise<PooledConnection>
	drain(): Promise<void>
	destroy(): Promise<void>
}
