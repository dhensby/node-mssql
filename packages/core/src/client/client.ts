/**
 * `Client` and `createClient` (ADR-0018).
 *
 * Vertical-slice cut: the lifecycle gates (`pending` → `open` → `draining`
 * → `destroyed`), the bound `sql` tag, and the synchronous-construct /
 * async-connect / async-close / async-destroy methods. Round-out commits
 * extend the surface to:
 *
 * - `client.id` (ADR-0016 — id generator threaded from `ClientConfig`)
 * - `EventEmitter<{ close: ... }>` per-instance close event (ADR-0018)
 * - `mssql:client:state-change` diagnostics_channel publish (ADR-0014)
 * - `defaultTimeout` / `defaultIsolationLevel` threading (ADR-0013 / ADR-0006)
 * - `errorOnInfo` predicate plumbing (ADR-0007)
 * - `client.acquire()` / `client.transaction()` scope builders (ADR-0006)
 *
 * The state-machine semantics here match ADR-0018:
 * - `connect()` is required and async; rejection transitions to
 *   `'destroyed'` (terminal — retry by constructing a new client).
 * - `close()` is graceful drain; new acquires reject, queued continue.
 * - `destroy()` is force-close; in-flight aborts, queued waiters reject.
 * - Repeat calls to `connect()` / `close()` / `destroy()` return the same
 *   Promise as the first call (idempotency via stored Promises).
 */

import type { ExecuteRequest, ResultEvent } from '../driver/index.js';
import {
	ClientClosedError,
	ClientNotConnectedError,
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

export type ClientState = 'pending' | 'open' | 'draining' | 'destroyed';

// `Queryable` is currently a brand-only placeholder ([ADR-0011] /
// [ADR-0006] — the real shape lands when scope-builders ship). Hooks
// don't yet have anything meaningful to do with the value, so the Client
// supplies a sentinel object rather than a fully-typed Queryable. Tests
// that exercise hook bodies can swap this out via their own factory.
const queryableStub = {} as Queryable;
const stubBindQueryable: BindQueryable = (_conn) => queryableStub;

export class Client {
	readonly sql: PoolBoundSqlTag;

	#state: ClientState = 'pending';
	readonly #pool: Pool;

	#connectPromise: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	#destroyPromise: Promise<void> | null = null;

	constructor(config: ClientConfig) {
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
		this.sql = makePoolBoundSqlTag(this.#runner(), this.#acquire());
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
			// Never connected; nothing to drain. Transition straight to destroyed.
			this.#state = 'destroyed';
			return Promise.resolve();
		}
		// `open` → `draining`. Wait for pool drain, then `destroyed`.
		this.#state = 'draining';
		this.#closePromise = (async () => {
			try {
				await this.#pool.drain();
			} finally {
				this.#state = 'destroyed';
			}
		})();
		return this.#closePromise;
	}

	destroy(): Promise<void> {
		if (this.#destroyPromise !== null) return this.#destroyPromise;
		// Force-close from any state. Concurrent close()'s pool.drain() will
		// be unblocked by pool.destroy().
		this.#state = 'destroyed';
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
			this.#state = 'open';
		} catch (err) {
			// Rejected connect transitions to `'destroyed'` — retry by
			// constructing a new Client (ADR-0018, "Retrying after a failed
			// connect").
			this.#state = 'destroyed';
			throw err;
		}
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
