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
	type PoolClosedState,
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
import { createStateMachine, onceAsync } from '../util/index.js';
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
 * The typed event surface on {@link Client}, mirroring native streams:
 * `'draining'` fires (no payload) when a graceful `close()` of an open
 * client enters the draining phase, and `'close'` fires once per Client
 * lifetime on the terminal transition to `'destroyed'`. A force `destroy()`
 * (and `close()` of a never-connected client) goes straight to destroyed,
 * so it emits only `'close'`. No `'error'` event: connect failures arrive
 * on the `connect()` Promise rejection AND on
 * `close({ reason: 'connect-failure', error })`, and a runtime error during
 * a query reaches the consumer's `await` on the terminal — `EventEmitter`
 * is not involved.
 *
 * Cross-cutting transition observability lives on the
 * `mssql:client:state-change` `diagnostics_channel`; per-instance event
 * handling is here.
 */
export interface ClientEvents {
	/** A graceful `close()` of an open client has begun draining (no payload). */
	draining: []
	close: [ClientClosePayload]
}

// `Queryable` is currently a brand-only placeholder ([ADR-0011] /
// [ADR-0006] — the real shape lands when scope-builders ship). Hooks
// don't yet have anything meaningful to do with the value, so the Client
// supplies a sentinel object rather than a fully-typed Queryable. Tests
// that exercise hook bodies can swap this out via their own factory.
const queryableStub = {} as Queryable;
const stubBindQueryable: BindQueryable = (_conn) => queryableStub;

export class Client extends EventEmitter<ClientEvents> implements AsyncDisposable {
	readonly sql: PoolBoundSqlTag;

	readonly #pool: Pool;

	// State + transition seam (ADR-0024 §3). `onTransition` is the single
	// place the `'close'` event and `state-change` channel fire — see
	// `#onTransition`. The graph is non-linear (`destroyed` is reachable
	// from every other state).
	readonly #sm = createStateMachine<ClientState>({
		initial: 'pending',
		transitions: {
			pending: ['open', 'destroyed'],
			open: ['draining', 'destroyed'],
			draining: ['destroyed'],
			destroyed: [],
		},
		onTransition: (from, to) => { this.#onTransition(from, to); },
	});

	// Settle-once memoisation (ADR-0024 §4) for each lifecycle verb: every
	// caller of a verb shares the one in-flight promise.
	readonly #connectOnce = onceAsync((): Promise<Client> => this.#performConnect().then(() => this));
	readonly #closeOnce = onceAsync((): Promise<void> => this.#drain());
	readonly #destroyOnce = onceAsync((): Promise<void> => this.#forceDestroy());

	// `true` once `destroy()` has been requested — routes a concurrent or
	// later `close()` to await the (superseding) force-teardown instead of
	// resolving early. A routing signal, not an idempotency flag: the
	// settlement itself is `#destroyOnce`.
	#destroying = false;

	// The `'close'` payload to emit on the NEXT `→ destroyed` transition.
	// Set synchronously by `#transitionTo` right before the transition, so
	// the reason rides the edge (ADR-0024 §1) rather than living in state.
	#closeOnDestroy: ClientClosePayload | undefined;

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
		return this.#sm.state;
	}

	connect(): Promise<Client> {
		if (this.#sm.is('open')) return Promise.resolve(this);
		if (this.#sm.is('pending')) return this.#connectOnce();
		// Closed (draining | destroyed). The `is()` guards gate the conditions
		// but don't narrow `#sm.state`, so assert the closed-state type for the
		// error payload.
		const state = this.#sm.state;
		return Promise.reject(new ClientClosedError(`client is ${state}`, { state: state as PoolClosedState }));
	}

	close(): Promise<void> {
		// A requested destroy supersedes a graceful close — await the
		// force-teardown rather than resolve early (ADR-0024 §4: no caller
		// observes "done" before the work has settled).
		if (this.#destroying) return this.#destroyOnce();
		if (this.#sm.is('destroyed')) return Promise.resolve();
		if (this.#sm.is('pending')) {
			// Never connected; nothing to drain. Transition straight to
			// destroyed — fires `'close'` with `reason: 'drain'` (close()
			// is the graceful-shutdown verb regardless of what was
			// in-flight).
			this.#transitionTo('destroyed', { reason: 'drain' });
			return Promise.resolve();
		}
		return this.#closeOnce();
	}

	destroy(): Promise<void> {
		this.#destroying = true;
		return this.#destroyOnce();
	}

	// `await using client = await createClient(cfg).connect()` tears the
	// client down at scope exit. Disposal is `destroy()`, not `close()`: at
	// correct usage (work finished, connections released) the two are
	// identical, but if a connection is still held at scope exit a graceful
	// drain would hang waiting for a release that isn't coming — so disposal
	// force-closes, surfacing the leak rather than deadlocking.
	[Symbol.asyncDispose](): Promise<void> {
		return this.destroy();
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

	// `close()`'s settle op: graceful drain. `open → draining`, wait for
	// in-flight holders to release, then `→ destroyed` (`reason: 'drain'`).
	async #drain(): Promise<void> {
		this.#transitionTo('draining');
		try {
			await this.#pool.drain();
		} finally {
			this.#transitionTo('destroyed', { reason: 'drain' });
		}
	}

	// `destroy()`'s settle op: force-teardown from any state. State flips
	// to `destroyed` synchronously BEFORE the async pool teardown
	// (ADR-0018 ordering); a concurrent `close()`'s `pool.drain()` is
	// unblocked by `pool.destroy()`. If `close()` already reached
	// `destroyed`, the transition is a no-op and only `pool.destroy()` runs.
	async #forceDestroy(): Promise<void> {
		if (!this.#sm.is('destroyed')) {
			this.#transitionTo('destroyed', { reason: 'destroy' });
		}
		await this.#pool.destroy();
	}

	// Thread the `'close'` reason onto the edge (ADR-0024 §1), then perform
	// the transition. The state machine drops same-state no-ops and runs
	// `#onTransition` for real transitions, so the ordering below is
	// centralised and impossible to forget at a callsite.
	#transitionTo(
		to: ClientState,
		closeOpts?: { reason: ClientCloseReason; error?: MssqlError },
	): void {
		// `error?: undefined` is preferred over present-with-undefined in
		// the emitted payload — keep it absent when not set.
		this.#closeOnDestroy = closeOpts === undefined
			? undefined
			: closeOpts.error !== undefined
				? { reason: closeOpts.reason, error: closeOpts.error }
				: { reason: closeOpts.reason };
		this.#sm.to(to);
	}

	// The single transition side-effect seam (ADR-0024 §3), run by the
	// state machine AFTER `state` has mutated — a `'close'` handler reading
	// `client.state` sees the new value. Ordering per ADR-0018: state
	// (already done) → `'close'` event → `state-change` channel → the
	// originating Promise settles last.
	#onTransition(from: ClientState, to: ClientState): void {
		// `'draining'` fires on the graceful `open → draining` edge (close()
		// of an open client). destroy() and close()-of-pending skip draining
		// (straight to destroyed), so they emit only `'close'`.
		if (to === 'draining') {
			this.emit('draining');
		}
		// `'close'` fires only on the terminal transition, and only when a
		// reason was supplied. There's no `'error'` event by design
		// (ADR-0018) — connect failures arrive on the `connect()` Promise
		// rejection AND on `close({ reason: 'connect-failure', error })`.
		if (to === 'destroyed' && this.#closeOnDestroy !== undefined) {
			this.emit('close', this.#closeOnDestroy);
		}
		// Channel always publishes (including non-terminal transitions like
		// `pending → open`, `open → draining`) so APM lifecycle timelines
		// see every state change.
		clientStateChangeChannel.publish({ from, to });
	}

	// The runner the bound `sql` tag uses. Wraps the pool-bound runner
	// with the Client-state gate per ADR-0018:
	// - `pending` → ClientNotConnectedError
	// - `draining` / `destroyed` → ClientClosedError
	// - `open` → delegate to poolRunner
	//
	// Capture the state machine (not `const self = this`, not a snapshot) so
	// each `run()` reads the current state through `is()` rather than a
	// construction-time value.
	#runner(): RequestRunner {
		const inner = poolRunner(this.#pool);
		const sm = this.#sm;
		return {
			run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
				return (async function* () {
					if (sm.is('pending')) {
						throw new ClientNotConnectedError();
					}
					if (!sm.is('open')) {
						const state = sm.state;
						throw new ClientClosedError(`client is ${state}`, { state: state as PoolClosedState });
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
			if (this.#sm.is('pending')) {
				throw new ClientNotConnectedError();
			}
			if (!this.#sm.is('open')) {
				const state = this.#sm.state;
				throw new ClientClosedError(`client is ${state}`, { state: state as PoolClosedState });
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
