import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
	Connection,
	Driver,
	DriverOptions,
	Pool,
	PoolContext,
	PoolFactory,
	PooledConnection,
	PoolState,
	PoolStats,
	Queryable,
} from '../../src/index.js';
import { fakeConnection, fakeDriver, fakeDriverOptions } from '../support/fakes.js';

const driver = fakeDriver({ connectionFactory: () => fakeConnection({ id: 'conn_factory_1' }) });

class FakePool implements Pool {
	readonly ctx: PoolContext;
	#state: PoolState = 'open';
	#stats: PoolStats = { size: 0, available: 0, inUse: 0, pending: 0 };
	constructor(ctx: PoolContext) {
		this.ctx = ctx;
	}
	get state(): PoolState {
		return this.#state;
	}
	get stats(): PoolStats {
		return this.#stats;
	}
	async acquire(): Promise<PooledConnection> {
		const connection = await this.ctx.driver.open(this.ctx.driverOptions);
		if (this.ctx.hooks?.onAcquire) {
			await this.ctx.hooks.onAcquire(this.ctx.bindQueryable(connection));
		}
		const hooks = this.ctx.hooks;
		const bind = this.ctx.bindQueryable;
		const pooled: PooledConnection = {
			connection,
			release: async () => {
				if (hooks?.onRelease) {
					await hooks.onRelease(bind(connection));
				}
			},
			destroy: async () => {
				await connection.close();
			},
			[Symbol.asyncDispose]: async () => {
				await pooled.release();
			},
		};
		return pooled;
	}
	async drain(): Promise<void> {
		this.#state = 'draining';
	}
	async destroy(): Promise<void> {
		this.#state = 'destroyed';
	}
}

const fakePoolFactory: PoolFactory = (ctx) => new FakePool(ctx);

const queryableStub = Symbol('queryable-stub') as unknown as Queryable;
const bindQueryable = (_conn: Connection): Queryable => queryableStub;

describe('PoolFactory', () => {
	test('produces a Pool from a PoolContext', async () => {
		const pool = fakePoolFactory({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		assert.equal(pool.state, 'open');
		const pooled = await pool.acquire();
		assert.equal(pooled.connection.id, 'conn_factory_1');
	});

	test('threads driverOptions through to driver.open()', async () => {
		const seen: DriverOptions[] = [];
		const recordingDriver: Driver = {
			name: 'recording',
			types: {},
			async open(opts) {
				seen.push(opts);
				return fakeConnection();
			},
		};
		const pool = fakePoolFactory({
			driver: recordingDriver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		await pool.acquire();
		assert.equal(seen.length, 1);
		assert.equal(seen[0], fakeDriverOptions);
	});
});

describe('PoolContext hooks', () => {
	test('onAcquire / onRelease receive a Queryable', async () => {
		const acquired: Queryable[] = [];
		const released: Queryable[] = [];
		const pool = fakePoolFactory({
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

	test('optional; factory works without hooks', async () => {
		const pool = fakePoolFactory({
			driver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		const pooled = await pool.acquire();
		await pooled.release();
		assert.equal(pool.state, 'open');
	});
});
