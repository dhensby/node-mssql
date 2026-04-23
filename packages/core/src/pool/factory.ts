import type { Connection, Driver } from '../driver/index.js'
import type { PoolHooks, Queryable } from './hooks.js'
import type { Pool } from './pool.js'

/**
 * Opaque placeholder for the factory that binds a driver-port `Connection`
 * into a `Queryable` for hook bodies. The kernel (ADR-0006) will provide
 * the real implementation; the pool port only needs the signature so
 * adapters can wire hooks without knowing the kernel's internals.
 *
 * TODO(ADR-0006): pin this to the real binder.
 */
export type BindQueryable = (conn: Connection) => Queryable

export interface PoolContext {
	readonly driver: Driver
	readonly hooks?: PoolHooks
	readonly bindQueryable: BindQueryable
}

export type PoolFactory = (ctx: PoolContext) => Pool
