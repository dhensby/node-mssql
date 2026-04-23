/**
 * Opaque placeholder for the unified Queryable surface (ADR-0006).
 *
 * TODO(ADR-0006): replace with the real `Queryable` type once the kernel
 * lands. The pool port only needs the identity — hooks receive a `Queryable`
 * bound to the just-acquired Connection — so an opaque placeholder keeps
 * adapter signatures stable across the Queryable implementation work.
 */
export interface Queryable {
	readonly [queryableBrand]: true
}

declare const queryableBrand: unique symbol

export interface PoolHooks {
	onAcquire?(sql: Queryable): Promise<void>
	onRelease?(sql: Queryable): Promise<void>
}
