/**
 * `SingleConnectionPool` — the no-pool short-circuit (ADR-0011).
 *
 * Implements the {@link Pool} port with cardinality one: a single
 * `Connection` is opened on first `acquire()`, held for the life of the
 * pool, and reused across acquires. Concurrent acquires queue against the
 * single slot in FIFO order. The pool runs the same `onAcquire` /
 * `onRelease` hook contract every adapter honours, with the same
 * validate-vs-create failure split: an `onAcquire` failure on the cached
 * connection retries once with a freshly-opened one (validate-failure
 * recovery); a failure to open a fresh connection surfaces immediately
 * (create-failure).
 *
 * The intended deployment shape is edge / serverless / short-lived
 * processes where a real pool's idle reaper, min/max sizing, and
 * pre-warming buy nothing — a single connection held for the invocation
 * is closer to optimal. Long-running services with concurrent traffic
 * are better served by `@tediousjs/mssql-tarn`.
 */

import type { Connection } from '../driver/index.js';
import { abortErrorFromSignal, PoolClosedError } from '../errors/index.js';
import type { PoolContext, PoolFactory, PoolOptions } from './factory.js';
import type { Pool, PooledConnection, PoolState, PoolStats } from './pool.js';

interface Waiter {
	resolve(conn: Connection): void
	reject(err: unknown): void
	cleanup(): void
}

const poolClosedError = (state: 'draining' | 'destroyed'): PoolClosedError =>
	new PoolClosedError(`pool is ${state}`, { state });

const swallow = (): void => {
	/* deliberate: close errors during teardown are unrecoverable */
};

export class SingleConnectionPool implements Pool {
	readonly #ctx: PoolContext;
	// Note: PoolOptions.min/max are not stored. They reach the factory via
	// `ctx.poolOptions` (connection-string-derived) and the factory's `opts`
	// argument, but for cardinality one they are advisory at best — `max ≥ 1`
	// is trivially satisfied, `min ≤ 1` matches eager-open behaviour, and
	// `min > 1` is logically inconsistent. The factory's merge step
	// (ADR-0011) preserves them for adapters that *do* honour them.

	#state: PoolState = 'open';
	#connection: Connection | null = null;
	#inUse = false;
	#waiters: Waiter[] = [];

	#drainPromise: Promise<void> | null = null;
	#drainResolve: (() => void) | null = null;
	#destroyPromise: Promise<void> | null = null;

	constructor(ctx: PoolContext) {
		this.#ctx = ctx;
	}

	get state(): PoolState {
		return this.#state;
	}

	get stats(): PoolStats {
		const have = this.#connection !== null ? 1 : 0;
		return {
			size: have,
			available: have === 1 && !this.#inUse ? 1 : 0,
			inUse: this.#inUse ? 1 : 0,
			pending: this.#waiters.length,
		};
	}

	async acquire(signal?: AbortSignal): Promise<PooledConnection> {
		// New acquires reject during draining / after destroy. In-flight
		// acquires that have already entered the queue continue to be served
		// per the "drain serves queued acquires" port contract (ADR-0011).
		if (this.#state !== 'open') {
			throw poolClosedError(this.#state);
		}
		if (signal?.aborted === true) {
			throw abortErrorFromSignal(signal, { phase: 'pool-acquire' });
		}

		const connection = await this.#takeSlot(signal);
		return this.#makePooled(connection);
	}

	// Non-async so repeat callers get reference-equal Promises (idempotency
	// per ADR-0011 / ADR-0018). An `async` wrapper here would create a new
	// outer Promise on each call.
	drain(): Promise<void> {
		if (this.#destroyPromise !== null) {
			return this.#destroyPromise;
		}
		if (this.#drainPromise !== null) {
			return this.#drainPromise;
		}
		if (this.#state === 'destroyed') return Promise.resolve();

		this.#state = 'draining';
		this.#drainPromise = new Promise<void>((res) => {
			this.#drainResolve = res;
		});

		// If the slot is already idle and no waiters are queued, finish drain
		// inline; otherwise the last `#releaseSlot()` will trigger it.
		if (!this.#inUse && this.#waiters.length === 0) {
			void this.#completeDrain();
		}

		return this.#drainPromise;
	}

	// See `drain()` — non-async for the same idempotency reason.
	destroy(): Promise<void> {
		if (this.#destroyPromise !== null) {
			return this.#destroyPromise;
		}

		this.#destroyPromise = (async () => {
			this.#state = 'destroyed';

			// Reject everyone waiting in the queue. Force-close abandons the
			// drain semantics so queued acquires don't get to land.
			const queued = this.#waiters.splice(0);
			for (const w of queued) {
				w.cleanup();
				w.reject(poolClosedError('destroyed'));
			}

			// Close the held connection if any. This aborts whatever execute
			// the current holder (if any) is running — they observe a driver
			// error or a connection-close event from inside their stream.
			if (this.#connection !== null) {
				const conn = this.#connection;
				this.#connection = null;
				await conn.close().catch(swallow);
			}

			// Resolve any in-flight drain Promise so awaiters complete.
			this.#drainResolve?.();
		})();

		return this.#destroyPromise;
	}

	// ───────────────────────── internals ─────────────────────────

	async #takeSlot(signal: AbortSignal | undefined): Promise<Connection> {
		// Fast path: the slot is free, take it now.
		if (!this.#inUse) {
			this.#inUse = true;
			try {
				const conn = await this.#establishConnection();
				// Race window: destroy() may have run while we were establishing.
				if (this.#state === 'destroyed') {
					await this.#dropEstablished(conn);
					throw poolClosedError('destroyed');
				}
				return conn;
			} catch (err) {
				// Failed to land a healthy connection. Hand the slot to the
				// next waiter (who'll likely also fail, but the contract is
				// "rejection per acquire", not "first failure poisons all").
				this.#inUse = false;
				this.#dispatchNext();
				throw err;
			}
		}

		// Slow path: the slot is in use — queue and wait for handoff.
		return await new Promise<Connection>((resolve, reject) => {
			let onAbort: (() => void) | undefined;
			const waiter: Waiter = {
				resolve,
				reject,
				cleanup: () => {
					if (signal !== undefined && onAbort !== undefined) {
						signal.removeEventListener('abort', onAbort);
					}
				},
			};
			if (signal !== undefined) {
				onAbort = (): void => {
					const idx = this.#waiters.indexOf(waiter);
					if (idx >= 0) this.#waiters.splice(idx, 1);
					waiter.cleanup();
					reject(abortErrorFromSignal(signal, { phase: 'pool-acquire' }));
				};
				signal.addEventListener('abort', onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	// Returns a healthy, hook-applied Connection or throws. Implements the
	// ADR-0011 validate-vs-create split: an `onAcquire` failure on the
	// cached connection retries once on a freshly-opened one (silent
	// validate-failure recovery); a failure to open a fresh connection
	// surfaces immediately as the underlying driver error.
	async #establishConnection(): Promise<Connection> {
		// Attempt 1: try the cached connection if we have one.
		if (this.#connection !== null) {
			const cached = this.#connection;
			try {
				await this.#runOnAcquire(cached);
				return cached;
			} catch {
				// Validate-failure on cached: discard and create fresh.
				this.#connection = null;
				await cached.close().catch(swallow);
			}
		}

		// Attempt 2 (or 1, if there was no cached): create fresh.
		const fresh = await this.#ctx.driver.open(this.#ctx.driverOptions);
		this.#connection = fresh;
		try {
			await this.#runOnAcquire(fresh);
		} catch (hookErr) {
			// Validate-failure on a freshly-opened connection — give up.
			// Surfacing the hook error rather than burning more attempts
			// matches "the pool only retries when the cached candidate is
			// suspect; a fresh opener that fails validation is an honest
			// failure" (ADR-0011).
			this.#connection = null;
			await fresh.close().catch(swallow);
			throw hookErr;
		}
		return fresh;
	}

	async #runOnAcquire(conn: Connection): Promise<void> {
		const onAcquire = this.#ctx.hooks?.onAcquire;
		if (onAcquire !== undefined) {
			await onAcquire(this.#ctx.bindQueryable(conn));
		}
	}

	async #runOnRelease(conn: Connection): Promise<void> {
		const onRelease = this.#ctx.hooks?.onRelease;
		if (onRelease !== undefined) {
			await onRelease(this.#ctx.bindQueryable(conn));
		}
	}

	#dispatchNext(): void {
		// If we're already destroyed, anything left in the queue at this
		// point is from a TOCTOU race and gets rejected.
		if (this.#state === 'destroyed') {
			const queued = this.#waiters.splice(0);
			for (const w of queued) {
				w.cleanup();
				w.reject(poolClosedError('destroyed'));
			}
			return;
		}

		const next = this.#waiters.shift();
		if (next === undefined) {
			// No one waiting. If we're draining and the slot is idle,
			// graceful shutdown completes here.
			if (this.#state === 'draining' && !this.#inUse) {
				void this.#completeDrain();
			}
			return;
		}

		next.cleanup();
		this.#inUse = true;

		// Establish runs async; resolve the waiter when it lands.
		this.#establishConnection().then(
			async (conn) => {
				if (this.#state === 'destroyed') {
					// Pool destroyed during establish; discard the connection
					// rather than hand it to a waiter who can't use it.
					await this.#dropEstablished(conn);
					next.reject(poolClosedError('destroyed'));
					return;
				}
				next.resolve(conn);
			},
			(err: unknown) => {
				next.reject(err);
				this.#inUse = false;
				this.#dispatchNext();
			},
		);
	}

	#releaseSlot(): void {
		this.#inUse = false;
		this.#dispatchNext();
	}

	async #completeDrain(): Promise<void> {
		// Idempotency: drain may also race with destroy.
		if (this.#state === 'destroyed') {
			this.#drainResolve?.();
			return;
		}
		if (this.#connection !== null) {
			const conn = this.#connection;
			this.#connection = null;
			await conn.close().catch(swallow);
		}
		this.#state = 'destroyed';
		this.#drainResolve?.();
	}

	async #dropEstablished(conn: Connection): Promise<void> {
		if (this.#connection === conn) this.#connection = null;
		await conn.close().catch(swallow);
	}

	#makePooled(conn: Connection): PooledConnection {
		let released = false;

		const release = async (): Promise<void> => {
			if (released) return;
			released = true;

			// Pool was force-destroyed while we were holding: the connection
			// is already closed and our slot is already accounted for.
			if (this.#state === 'destroyed') return;

			try {
				await this.#runOnRelease(conn);
				await conn.reset();
			} catch {
				// onRelease threw, or reset failed. Per ADR-0011 the adapter
				// destroys this connection rather than returning it to the
				// idle set; the next acquire opens fresh.
				if (this.#connection === conn) this.#connection = null;
				await conn.close().catch(swallow);
			}

			this.#releaseSlot();
		};

		const destroy = async (): Promise<void> => {
			if (released) return;
			released = true;

			if (this.#connection === conn) this.#connection = null;
			await conn.close().catch(swallow);

			// If the pool itself is destroyed, slot bookkeeping is already
			// handled. Otherwise advance the queue.
			if (this.#state !== 'destroyed') {
				this.#releaseSlot();
			}
		};

		return {
			connection: conn,
			release,
			destroy,
			[Symbol.asyncDispose]: release,
		};
	}
}

/**
 * User-facing factory for the no-pool short-circuit (ADR-0011).
 *
 * Returns a {@link PoolFactory} the Client invokes with the full
 * {@link PoolContext} at construction time. User options override
 * connection-string-derived options (factory wins) per the merge rule
 * documented on the ADR — even though SingleConnection doesn't honour
 * `min` / `max` at runtime, the merge happens here for parity with
 * adapters that do. Cardinality one trivially satisfies `max ≥ 1` and
 * matches `min ≤ 1`; `min > 1` is logically inconsistent and currently
 * unvalidated (the port leaves validation to adapters).
 */
export function singleConnection(options?: PoolOptions): PoolFactory {
	return (ctx: PoolContext): Pool => {
		// Merge purely so the factory's signature matches the contract
		// (factory > connection-string for portable fields). Result is
		// retained on the merged context but not consumed by the pool —
		// SingleConnection's cardinality is fixed.
		const mergedCtx: PoolContext = {
			...ctx,
			poolOptions: { ...ctx.poolOptions, ...options },
		};
		return new SingleConnectionPool(mergedCtx);
	};
}
