/**
 * `Client` and `createClient` (ADR-0018).
 *
 * Round-out cut R-7: adds the `EventEmitter` surface and the
 * `mssql:client:state-change` diagnostics_channel emission per
 * ADR-0014 / ADR-0018. Earlier round-outs added the lifecycle gates
 * (`pending` → `open` → `draining` → `destroyed`), the bound `sql`
 * tag, and the `defaultIsolationLevel` threading. Future round-outs
 * extend further:
 *
 * - `client.id` (ADR-0016 — id generator threaded from `ClientConfig`)
 * - `defaultTimeout` (ADR-0013)
 * - `errorOnInfo` predicate plumbing (ADR-0007)
 *
 * Event + channel ordering on the terminal (`→ destroyed`)
 * transition is deterministic per ADR-0018, "Client events":
 *
 * 1. `#state` is mutated synchronously (a `close`-event handler
 *    reading `client.state` sees `'destroyed'`).
 * 2. The `'close'` event fires synchronously
 *    (`{ reason, error? }`) for per-instance subscribers.
 * 3. `mssql:client:state-change` publishes `{ from, to }` for
 *    cross-cutting telemetry subscribers.
 * 4. The originating `connect()` / `close()` / `destroy()` Promise
 *    settles last.
 *
 * The two observability surfaces serve different audiences. The
 * `'close'` event is per-instance, for code holding a Client
 * reference (`client.once('close', cleanup)`). The channel is
 * process-wide telemetry covering every Client and every transition
 * (including non-terminal ones); APM tools subscribe to it without
 * needing references to specific Client instances.
 */

import { EventEmitter } from 'node:events';
import { clientStateChangeChannel } from '../diagnostics/index.js';
import type { ExecuteRequest, ResultEvent } from '../driver/index.js';
import {
	ClientClosedError,
	ClientNotConnectedError,
	type MssqlError,
} from '../errors/index.js';
import type {
	BindQueryable,
	Pool,
	PoolFactory,
	PooledConnection,
	Queryable,
} from '../pool/index.js';
import { singleConnection } from '../pool/index.js';
import type { RequestRunner } from '../query/index.js';
import { poolRunner } from '../query/pool-runner.js';
import { makePoolBoundSqlTag, type PoolBoundSqlTag } from '../sql/index.js';
import type { ClientConfig } from './config.js';
import type { ClientState } from './state.js';

export type { ClientState };

/**
 * Discriminator for the `'close'` event's cause. The same Client
 * cannot fire `'close'` more than once (terminal transition), so the
 * three reasons are mutually exclusive for a given Client lifetime.
 */
export type ClientCloseReason = 'connect-failure' | 'drain' | 'destroy';

/**
 * Payload for the {@link Client}'s `'close'` event.
 *
 * `error` is set ONLY for `reason: 'connect-failure'` — it carries
 * the `ConnectionError` / `CredentialError` that rejected the
 * originating `connect()`. For `'drain'` and `'destroy'` reasons,
 * `error` is `undefined`.
 */
export interface ClientClosePayload {
	readonly reason: ClientCloseReason
	readonly error?: MssqlError
}

/**
 * The typed event surface on {@link Client}. One event —  `'close'` —
 * fires once per Client lifetime when the Client transitions to
 * `'destroyed'`. No `'error'` event: connect failures arrive on the
 * `connect()` Promise rejection AND on `close({ reason: 'connect-failure', error })`,
 * and a runtime error during a query reaches the consumer's
 * `await` on the terminal — `EventEmitter` is not involved.
 *
 * Cross-cutting transition observability lives on the
 * `mssql:client:state-change` `diagnostics_channel`; per-instance
 * close handling is here.
 */
export interface ClientEvents {
	close: [ClientClosePayload]
}

// `Queryable` is currently a brand-only placeholder ([ADR-0011] /
// [ADR-0006] — the real shape lands when scope-builders ship). Hooks
// don't yet have anything meaningful to do with the value, so the Client
// supplies a sentinel object rather than a fully-typed Queryable. Tests
// that exercise hook bodies can swap this out via their own factory.
const queryableStub = {} as Queryable;
const stubBindQueryable: BindQueryable = (_conn) => queryableStub;

export class Client extends EventEmitter<ClientEvents> {
	readonly sql: PoolBoundSqlTag;

	#state: ClientState = 'pending';
	readonly #pool: Pool;

	#connectPromise: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	#destroyPromise: Promise<void> | null = null;

	constructor(config: ClientConfig) {
		super();
		const factory: PoolFactory = config.pool ?? singleConnection();
		this.#pool = factory({
			driver: config.driver,
			driverOptions: {
				credential: config.credential,
				transport: config.transport,
			},
			...(config.hooks !== undefined ? { hooks: config.hooks } : {}),
			bindQueryable: stubBindQueryable,
		});
		this.sql = makePoolBoundSqlTag(
			this.#runner(),
			this.#acquire(),
			config.defaultIsolationLevel,
		);
	}

	get state(): ClientState {
		return this.#state;
	}

	connect(): Promise<void> {
		if (this.#connectPromise !== null) return this.#connectPromise;
		if (this.#state === 'open') return Promise.resolve();
		if (this.#state !== 'pending') {
			return Promise.reject(
				new ClientClosedError(`client is ${this.#state}`, {
					state: this.#state,
				}),
			);
		}
		this.#connectPromise = this.#performConnect();
		return this.#connectPromise;
	}

	close(): Promise<void> {
		if (this.#destroyPromise !== null) return this.#destroyPromise;
		if (this.#closePromise !== null) return this.#closePromise;
		if (this.#state === 'destroyed') return Promise.resolve();
		if (this.#state === 'pending') {
			// Never connected; nothing to drain. Transition straight to
			// destroyed — fires `'close'` with `reason: 'drain'` (close()
			// is the graceful-shutdown verb regardless of what was
			// in-flight).
			this.#transitionTo('destroyed', { reason: 'drain' });
			return Promise.resolve();
		}
		// `open` → `draining`. Wait for pool drain, then `destroyed`.
		this.#transitionTo('draining');
		this.#closePromise = (async () => {
			try {
				await this.#pool.drain();
			} finally {
				this.#transitionTo('destroyed', { reason: 'drain' });
			}
		})();
		return this.#closePromise;
	}

	destroy(): Promise<void> {
		if (this.#destroyPromise !== null) return this.#destroyPromise;
		// Force-close from any state. Concurrent close()'s pool.drain()
		// will be unblocked by pool.destroy().
		// State transitions to `'destroyed'` BEFORE the async pool
		// teardown — matches ADR-0018's ordering ("state changes
		// synchronously, close event fires synchronously, channel
		// publishes, Promise settles last").
		const wasAlreadyDestroyed = this.#state === 'destroyed';
		if (!wasAlreadyDestroyed) {
			this.#transitionTo('destroyed', { reason: 'destroy' });
		}
		this.#destroyPromise = (async () => {
			await this.#pool.destroy();
		})();
		return this.#destroyPromise;
	}

	async #performConnect(): Promise<void> {
		// Eager validate: acquire and immediately release via the
		// `await using` disposal path. If the pool can't open (auth,
		// network, misconfig), the rejection surfaces here at the
		// bootstrap call site (ADR-0018).
		try {
			await using _pooled = await this.#pool.acquire();
			this.#transitionTo('open');
		} catch (err) {
			// Rejected connect transitions to `'destroyed'` — retry by
			// constructing a new Client (ADR-0018, "Retrying after a
			// failed connect"). Fires `'close'` with
			// `reason: 'connect-failure'` and the originating error so
			// per-instance lifecycle subscribers can react without
			// catching the `connect()` Promise themselves.
			this.#transitionTo('destroyed', {
				reason: 'connect-failure',
				error: err as MssqlError,
			});
			throw err;
		}
	}

	// Single transition primitive — every state mutation goes through
	// here so the ADR-0018 ordering (state → close event → channel →
	// Promise) is centralised and impossible to forget at a callsite.
	//
	// Same-state transitions are silently dropped. The Client's own
	// callers never request a no-op transition, but the guard means
	// repeated `destroy()` / `close()` paths that re-enter via stored
	// Promises don't double-fire.
	#transitionTo(
		to: ClientState,
		closeOpts?: { reason: ClientCloseReason; error?: MssqlError },
	): void {
		const from = this.#state;
		if (from === to) return;
		// 1. State first — a `'close'` handler reading `client.state`
		//    must see the new value.
		this.#state = to;
		// 2. `'close'` event for terminal-only transitions. There's no
		//    `'error'` event by design (ADR-0018) — connect failures
		//    arrive on the `connect()` Promise rejection AND on
		//    `close({ reason: 'connect-failure', error })` for
		//    per-instance subscribers wanting both surfaces.
		if (to === 'destroyed' && closeOpts !== undefined) {
			// `error?: undefined` is preferred over present-with-undefined
			// in the emitted payload — keep it absent when not set.
			const payload: ClientClosePayload = closeOpts.error !== undefined
				? { reason: closeOpts.reason, error: closeOpts.error }
				: { reason: closeOpts.reason };
			this.emit('close', payload);
		}
		// 3. Diagnostics channel for cross-cutting subscribers. Always
		//    publishes (including non-terminal transitions like
		//    `pending → open`, `open → draining`) so APM lifecycle
		//    timelines see every state change.
		clientStateChangeChannel.publish({ from, to });
	}

	// The runner the bound `sql` tag uses. Wraps the pool-bound runner
	// with the Client-state gate per ADR-0018:
	// - `pending` → ClientNotConnectedError
	// - `draining` / `destroyed` → ClientClosedError
	// - `open` → delegate to poolRunner
	//
	// Closure over an arrow function (not `const self = this`) so the
	// generator's `state` reflects the current value on each `run()`
	// call rather than the construction-time snapshot.
	#runner(): RequestRunner {
		const inner = poolRunner(this.#pool);
		const getState = (): ClientState => this.#state;
		return {
			run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
				return (async function* () {
					const state = getState();
					if (state === 'pending') {
						throw new ClientNotConnectedError();
					}
					if (state !== 'open') {
						// At this point `state` narrows to `'draining' | 'destroyed'`,
						// matching `PoolClosedState`.
						throw new ClientClosedError(`client is ${state}`, { state });
					}
					for await (const event of inner.run(req, signal)) {
						yield event;
					}
				})();
			},
		};
	}

	// Pool-acquire wrapper used by `sql.acquire()`. Gates on the Client's
	// state so `await sql.acquire()` rejects with the same lifecycle
	// errors the tag would (per ADR-0018). The pool's own state-gating
	// kicks in for `draining` / `destroyed` — no need to duplicate; we
	// only handle the `pending` case (Client knows about it; pool does
	// not, since it was opened by the Client's own connect()).
	#acquire(): (signal?: AbortSignal) => Promise<PooledConnection> {
		return async (signal?: AbortSignal): Promise<PooledConnection> => {
			if (this.#state === 'pending') {
				throw new ClientNotConnectedError();
			}
			if (this.#state !== 'open') {
				throw new ClientClosedError(`client is ${this.#state}`, {
					state: this.#state,
				});
			}
			return this.#pool.acquire(signal);
		};
	}
}

/**
 * Construct a {@link Client} from {@link ClientConfig}. Synchronous —
 * no work happens against the wire until `await client.connect()` fires.
 */
export function createClient(config: ClientConfig): Client {
	return new Client(config);
}
