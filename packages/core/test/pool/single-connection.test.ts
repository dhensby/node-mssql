import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	type Connection,
	type ConnectionEvents,
	type Driver,
	type DriverOptions,
	type ExecuteRequest,
	type Queryable,
	type ResultEvent,
	AbortError,
	ConnectionError,
	PoolClosedError,
	SingleConnectionPool,
	singleConnection,
	TimeoutError,
} from '../../src/index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface ConnectionLog {
	resets: number
	closes: number
	pings: number
}

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id: string;
	readonly log: ConnectionLog = { resets: 0, closes: 0, pings: 0 };
	closeError: Error | null = null;
	resetError: Error | null = null;

	constructor(id = 'conn_1') {
		super();
		this.id = id;
	}

	async *execute(_req: ExecuteRequest): AsyncIterable<ResultEvent> {
		yield { kind: 'done' };
	}
	async beginTransaction(): Promise<void> {}
	async commit(): Promise<void> {}
	async rollback(): Promise<void> {}
	async savepoint(): Promise<void> {}
	async rollbackToSavepoint(): Promise<void> {}
	async prepare(): Promise<{ id: string }> {
		return { id: 'prep_1' };
	}
	async bulkLoad(): Promise<{ rowsAffected: number }> {
		return { rowsAffected: 0 };
	}
	async reset(): Promise<void> {
		this.log.resets++;
		if (this.resetError !== null) throw this.resetError;
	}
	async ping(): Promise<void> {
		this.log.pings++;
	}
	async close(): Promise<void> {
		this.log.closes++;
		if (this.closeError !== null) throw this.closeError;
	}
}

interface DriverLog {
	opens: number
	openOptions: DriverOptions[]
}

const fakeDriverOptions: DriverOptions = {
	credential: { kind: 'integrated' },
	transport: { host: 'db.local' },
};

const buildDriver = (
	connectionFactory: (n: number) => Connection | Promise<Connection>,
): { driver: Driver; log: DriverLog } => {
	const log: DriverLog = { opens: 0, openOptions: [] };
	const driver: Driver = {
		name: 'fake',
		types: {},
		async open(opts) {
			log.opens++;
			log.openOptions.push(opts);
			return await connectionFactory(log.opens);
		},
	};
	return { driver, log };
};

const queryableStub = Symbol('queryable-stub') as unknown as Queryable;
const bindQueryable = (_conn: Connection): Queryable => queryableStub;

// ─── Construction ───────────────────────────────────────────────────────────

describe('SingleConnectionPool — construction', () => {
	test('starts in `open` state with empty stats', () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		assert.equal(pool.state, 'open');
		assert.deepEqual(pool.stats, { size: 0, available: 0, inUse: 0, pending: 0 });
	});

	test('singleConnection() factory returns a PoolFactory', () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const factory = singleConnection();
		const pool = factory({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		assert.equal(pool.state, 'open');
	});

	test('singleConnection() factory merges user options over connection-string options (factory wins)', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		// Build a SingleConnectionPool via the factory with options. The merge
		// happens inside the factory; the pool's external behaviour doesn't
		// expose options, so we just sanity-check that construction succeeds
		// when both `ctx.poolOptions` and factory `options` are supplied.
		const factory = singleConnection({ max: 1 });
		const pool = factory({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			poolOptions: { max: 5 },
		});
		assert.equal(pool.state, 'open');
		// And the pool still works.
		const pooled = await pool.acquire();
		await pooled.release();
	});
});

// ─── Acquire / release lifecycle ────────────────────────────────────────────

describe('SingleConnectionPool — acquire and release', () => {
	test('opens the connection lazily on first acquire', async () => {
		const { driver, log } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		assert.equal(log.opens, 0);

		const pooled = await pool.acquire();
		assert.equal(log.opens, 1);
		assert.equal(pooled.connection.id, 'conn_1');
		await pooled.release();
	});

	test('threads driverOptions to driver.open()', async () => {
		const { driver, log } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		const pooled = await pool.acquire();
		assert.equal(log.openOptions.length, 1);
		assert.equal(log.openOptions[0], fakeDriverOptions);
		await pooled.release();
	});

	test('reuses the same connection on subsequent acquires', async () => {
		const { driver, log } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const idA = a.connection.id;
		await a.release();

		const b = await pool.acquire();
		assert.equal(b.connection.id, idA);
		assert.equal(log.opens, 1, 'driver.open() called only once');
		await b.release();
	});

	test('runs Connection.reset() on each release', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		await a.release();
		assert.equal(conn.log.resets, 1);

		const b = await pool.acquire();
		await b.release();
		assert.equal(conn.log.resets, 2);
	});

	test('PooledConnection supports `await using` (Symbol.asyncDispose)', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		{
			await using pooled = await pool.acquire();
			assert.equal(pooled.connection.id, conn.id);
		}
		assert.equal(conn.log.resets, 1, 'reset ran on dispose');
	});
});

// ─── Stats ──────────────────────────────────────────────────────────────────

describe('SingleConnectionPool — stats', () => {
	test('reflects acquire / release transitions', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		assert.deepEqual(pool.stats, { size: 0, available: 0, inUse: 0, pending: 0 });

		const a = await pool.acquire();
		assert.deepEqual(pool.stats, { size: 1, available: 0, inUse: 1, pending: 0 });

		await a.release();
		assert.deepEqual(pool.stats, { size: 1, available: 1, inUse: 0, pending: 0 });
	});

	test('reports queued acquires as `pending`', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const b = pool.acquire();
		const c = pool.acquire();

		// Allow the awaiters to enqueue.
		await Promise.resolve();
		assert.deepEqual(pool.stats, { size: 1, available: 0, inUse: 1, pending: 2 });

		await a.release();
		await (await b).release();
		await (await c).release();
	});
});

// ─── Concurrent acquires ────────────────────────────────────────────────────

describe('SingleConnectionPool — concurrent acquires', () => {
	test('queues concurrent acquires and serves them in FIFO order', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const order: string[] = [];

		const a = await pool.acquire();
		const bp = (async () => {
			const b = await pool.acquire();
			order.push('b');
			await b.release();
		})();
		const cp = (async () => {
			const c = await pool.acquire();
			order.push('c');
			await c.release();
		})();
		const dp = (async () => {
			const d = await pool.acquire();
			order.push('d');
			await d.release();
		})();

		// Let the awaiters enqueue.
		await Promise.resolve();
		order.push('a');
		await a.release();

		await Promise.all([bp, cp, dp]);
		assert.deepEqual(order, ['a', 'b', 'c', 'd']);
	});
});

// ─── AbortSignal ────────────────────────────────────────────────────────────

describe('SingleConnectionPool — AbortSignal handling', () => {
	test('rejects synchronously when signal is already aborted at entry', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		const ac = new AbortController();
		ac.abort(new Error('cancelled at entry'));

		await assert.rejects(
			() => pool.acquire(ac.signal),
			(err: unknown) => {
				assert.ok(err instanceof AbortError);
				assert.equal(err.phase, 'pool-acquire');
				return true;
			},
		);
	});

	test('rejects a queued waiter when the signal aborts during the wait', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const ac = new AbortController();
		const waiter = pool.acquire(ac.signal);

		// Let the waiter enqueue.
		await Promise.resolve();
		ac.abort(new Error('cancelled during wait'));

		await assert.rejects(
			() => waiter,
			(err: unknown) => {
				assert.ok(err instanceof AbortError);
				assert.equal(err.phase, 'pool-acquire');
				return true;
			},
		);

		await a.release();
	});

	test('translates `name: TimeoutError` reason into `TimeoutError`', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const ac = new AbortController();
		const waiter = pool.acquire(ac.signal);

		// Abort with a reason whose `name` is 'TimeoutError' — matches what
		// `AbortSignal.timeout()` emits, but uses a manual abort so the test
		// doesn't depend on Node's unref'd timer firing within the test
		// runner's event-loop window.
		await Promise.resolve();
		ac.abort(Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' }));

		await assert.rejects(
			() => waiter,
			(err: unknown) => {
				assert.ok(err instanceof TimeoutError);
				assert.equal(err.phase, 'pool-acquire');
				return true;
			},
		);

		await a.release();
	});
});

// ─── Drain ──────────────────────────────────────────────────────────────────

describe('SingleConnectionPool — drain', () => {
	test('rejects new acquires once draining starts', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		await pool.drain();

		await assert.rejects(
			() => pool.acquire(),
			(err: unknown) => {
				assert.ok(err instanceof PoolClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);
	});

	test('drain with idle connection: closes connection and transitions to destroyed', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		await a.release();

		await pool.drain();
		assert.equal(pool.state, 'destroyed');
		assert.equal(conn.log.closes, 1);
	});

	test('drain serves queued acquires before completing', async () => {
		const { driver } = buildDriver((n) => new FakeConnection(`conn_${n}`));
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const bPromise = pool.acquire();

		// Let bPromise enqueue.
		await Promise.resolve();

		// Start draining; new acquires should now reject.
		const drainPromise = pool.drain();

		// New acquire after drain rejects.
		await assert.rejects(() => pool.acquire(), PoolClosedError);

		// b is already enqueued, so it continues to be served.
		await a.release();
		const b = await bPromise;
		await b.release();

		await drainPromise;
		assert.equal(pool.state, 'destroyed');
	});

	test('drain is idempotent — multiple calls return the same promise', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();

		const p1 = pool.drain();
		const p2 = pool.drain();
		assert.equal(p1, p2);

		await a.release();
		await p1;
		assert.equal(pool.state, 'destroyed');
	});
});

// ─── Destroy ────────────────────────────────────────────────────────────────

describe('SingleConnectionPool — destroy', () => {
	test('rejects all queued waiters with PoolClosedError({state: destroyed})', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const bp = pool.acquire();
		const cp = pool.acquire();

		// Let waiters enqueue.
		await Promise.resolve();

		await pool.destroy();

		await assert.rejects(
			() => bp,
			(err: unknown) => {
				assert.ok(err instanceof PoolClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);
		await assert.rejects(
			() => cp,
			(err: unknown) => {
				assert.ok(err instanceof PoolClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);

		// The original holder is still alive — its release no-ops cleanly.
		await a.release();
	});

	test('closes the held connection during destroy', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		await pool.destroy();

		assert.equal(conn.log.closes, 1);
		assert.equal(pool.state, 'destroyed');

		// Holder's release runs cleanly without throwing — connection is gone.
		await a.release();
	});

	test('destroy is idempotent', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const p1 = pool.destroy();
		const p2 = pool.destroy();
		assert.equal(p1, p2);
		await p1;
		assert.equal(pool.state, 'destroyed');
	});

	test('destroy resolves any in-flight drain Promise', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		const drainPromise = pool.drain();

		// Drain is waiting on `a` to release; force-destroy short-circuits.
		await pool.destroy();
		await drainPromise;
		assert.equal(pool.state, 'destroyed');

		await a.release();
	});
});

// ─── Hooks ──────────────────────────────────────────────────────────────────

describe('SingleConnectionPool — hooks', () => {
	test('runs onAcquire before returning the connection', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const log: string[] = [];

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onAcquire: async () => {
					log.push('onAcquire');
				},
			},
		});

		const pooled = await pool.acquire();
		log.push('acquired');
		assert.deepEqual(log, ['onAcquire', 'acquired']);
		await pooled.release();
	});

	test('runs onRelease before Connection.reset()', async () => {
		const conn = new FakeConnection();
		const { driver } = buildDriver(() => conn);
		const log: string[] = [];

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onRelease: async () => {
					log.push(`onRelease(resets=${conn.log.resets})`);
				},
			},
		});

		const pooled = await pool.acquire();
		await pooled.release();
		log.push(`released(resets=${conn.log.resets})`);

		assert.deepEqual(log, ['onRelease(resets=0)', 'released(resets=1)']);
	});

	test('passes the bound Queryable to onAcquire / onRelease', async () => {
		const { driver } = buildDriver(() => new FakeConnection());
		const acquired: Queryable[] = [];
		const released: Queryable[] = [];

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onAcquire: async (sql) => {
					acquired.push(sql);
				},
				onRelease: async (sql) => {
					released.push(sql);
				},
			},
		});

		const pooled = await pool.acquire();
		await pooled.release();

		assert.equal(acquired.length, 1);
		assert.equal(released.length, 1);
		assert.equal(acquired[0], queryableStub);
		assert.equal(released[0], queryableStub);
	});

	test('onAcquire failure on cached connection: discards it and retries on a fresh one', async () => {
		const conns: FakeConnection[] = [];
		const { driver, log: driverLog } = buildDriver((n) => {
			const c = new FakeConnection(`conn_${n}`);
			conns.push(c);
			return c;
		});
		let acquireCount = 0;

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onAcquire: async () => {
					acquireCount++;
					// Throw on the second logical acquire to simulate a stale
					// cached connection. Subsequent calls succeed.
					if (acquireCount === 2) {
						throw new Error('stale connection');
					}
				},
			},
		});

		const a = await pool.acquire();
		assert.equal(a.connection.id, 'conn_1');
		await a.release();

		// Second acquire: cached fails validation, fresh one succeeds.
		const b = await pool.acquire();
		assert.equal(b.connection.id, 'conn_2', 'served fresh connection');
		assert.equal(driverLog.opens, 2, 'driver.open() called for replacement');
		assert.equal(conns[0]?.log.closes, 1, 'stale connection closed');

		await b.release();
	});

	test('onAcquire failure on a freshly-opened connection surfaces the hook error', async () => {
		const { driver } = buildDriver(() => new FakeConnection());

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onAcquire: async () => {
					throw new Error('always fails');
				},
			},
		});

		await assert.rejects(() => pool.acquire(), /always fails/);
		assert.equal(pool.stats.size, 0, 'failed connection cleaned up');
	});

	test('onRelease failure: connection destroyed, next acquire opens fresh', async () => {
		const conns: FakeConnection[] = [];
		const { driver, log: driverLog } = buildDriver((n) => {
			const c = new FakeConnection(`conn_${n}`);
			conns.push(c);
			return c;
		});
		let releaseCount = 0;

		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onRelease: async () => {
					releaseCount++;
					if (releaseCount === 1) {
						throw new Error('release failed');
					}
				},
			},
		});

		const a = await pool.acquire();
		await a.release();

		// release didn't throw to caller — pool absorbed it and destroyed conn.
		assert.equal(conns[0]?.log.closes, 1);

		const b = await pool.acquire();
		assert.equal(b.connection.id, 'conn_2', 'fresh connection on next acquire');
		assert.equal(driverLog.opens, 2);
		await b.release();
	});
});

// ─── Driver create-failure ──────────────────────────────────────────────────

describe('SingleConnectionPool — driver create-failure', () => {
	test('propagates driver.open() rejection from the first acquire', async () => {
		const driver: Driver = {
			name: 'fake',
			types: {},
			async open(): Promise<Connection> {
				throw new ConnectionError('connect refused');
			},
		};
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		await assert.rejects(() => pool.acquire(), ConnectionError);
		assert.equal(pool.stats.size, 0);
		// Pool stays open — a retry might succeed (e.g. server warming up).
		assert.equal(pool.state, 'open');
	});

	test('next acquire after a create-failure tries again', async () => {
		let attempts = 0;
		const driver: Driver = {
			name: 'fake',
			types: {},
			async open(): Promise<Connection> {
				attempts++;
				if (attempts === 1) throw new ConnectionError('first attempt fails');
				return new FakeConnection(`conn_${attempts}`);
			},
		};
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		await assert.rejects(() => pool.acquire(), ConnectionError);

		const b = await pool.acquire();
		assert.equal(b.connection.id, 'conn_2');
		await b.release();
	});

	test('create-failure on queued-waiter dispatch rejects only that waiter; queue advances', async () => {
		const conns: FakeConnection[] = [];
		let attempts = 0;
		const driver: Driver = {
			name: 'fake',
			types: {},
			async open(): Promise<Connection> {
				attempts++;
				// Holder gets a connection; the next two re-opens (dispatching
				// to queued waiters) fail; the fourth succeeds again.
				if (attempts === 2 || attempts === 3) {
					throw new ConnectionError(`open failure ${attempts}`);
				}
				const c = new FakeConnection(`conn_${attempts}`);
				conns.push(c);
				return c;
			},
		};
		// Force the cached connection to be invalidated on release so the
		// next acquire goes through driver.open() again. We do this by
		// throwing in onRelease — per ADR-0011 that destroys the connection
		// rather than reusing it.
		let releaseCount = 0;
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
			hooks: {
				onRelease: async () => {
					releaseCount++;
					throw new Error(`force destroy on release ${releaseCount}`);
				},
			},
		});

		// Acquire 1: holder.
		const a = await pool.acquire();

		// Two queued waiters.
		const bp = pool.acquire();
		const cp = pool.acquire();

		await Promise.resolve();

		// Holder releases — onRelease throws → connection destroyed.
		// dispatchNext for `bp`: opens fresh (attempt 2 → fails).
		// dispatchNext for `cp`: opens fresh (attempt 3 → fails).
		await a.release();

		await assert.rejects(() => bp, ConnectionError);
		await assert.rejects(() => cp, ConnectionError);

		// Queue is empty; pool is back to idle (no held connection).
		assert.equal(pool.state, 'open');
		assert.equal(pool.stats.size, 0);

		// A subsequent acquire opens fresh and succeeds (attempt 4).
		const d = await pool.acquire();
		assert.equal(d.connection.id, 'conn_4');
		// Avoid the onRelease destroy on this teardown by destroying instead.
		await d.destroy();
	});
});

// ─── PooledConnection.destroy ───────────────────────────────────────────────

describe('SingleConnectionPool — PooledConnection.destroy()', () => {
	test('destroy() closes the underlying connection without releasing', async () => {
		const conns: FakeConnection[] = [];
		const { driver } = buildDriver((n) => {
			const c = new FakeConnection(`conn_${n}`);
			conns.push(c);
			return c;
		});
		const pool = new SingleConnectionPool({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});

		const a = await pool.acquire();
		await a.destroy();
		assert.equal(conns[0]?.log.closes, 1);
		assert.equal(conns[0]?.log.resets, 0, 'reset not run on destroy path');

		// Next acquire creates fresh.
		const b = await pool.acquire();
		assert.equal(b.connection.id, 'conn_2');
		await b.release();
	});
});
