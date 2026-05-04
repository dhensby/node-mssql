import type { Connection, Driver } from '../driver/index.js';
import type { PoolHooks, Queryable } from './hooks.js';
import type { Pool } from './pool.js';

/**
 * Opaque placeholder for the factory that binds a driver-port `Connection`
 * into a `Queryable` for hook bodies. The kernel (ADR-0006) will provide
 * the real implementation; the pool port only needs the signature so
 * adapters can wire hooks without knowing the kernel's internals.
 *
 * TODO(ADR-0006): pin this to the real binder.
 */
export type BindQueryable = (conn: Connection) => Queryable;

// Portable pool options. `min` and `max` are the universal pool concepts
// every adapter can speak; anything adapter-specific (idle reaper,
// connection lifetime, validation policy, tarn's `propagateCreateError`,
// etc.) goes in `.native`. Timeouts are deliberately not in this shape —
// acquire timing is controlled by `AbortSignal`, per the cancellation
// contract in ADR-0011.
export interface PoolOptions<N = unknown> {
	readonly min?: number
	readonly max?: number
	readonly native?: N
}

export interface PoolContext {
	readonly driver: Driver
	readonly hooks?: PoolHooks
	readonly bindQueryable: BindQueryable
	// Connection-string-parsed pool options reach the factory here, so
	// the factory can merge with explicit user options (ADR-0011 / ADR-0015).
	readonly poolOptions?: PoolOptions
}

export type PoolFactory = (ctx: PoolContext) => Pool;
