import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type {
	Connection,
	ConnectionEvents,
	Driver,
	DriverOptions,
	ExecuteRequest,
	Pool,
	PoolContext,
	PoolFactory,
	PooledConnection,
	PoolState,
	PoolStats,
	Queryable,
	ResultEvent,
} from '../../src/index.js';

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id = 'conn_factory_1';
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
	async reset(): Promise<void> {}
	async ping(): Promise<void> {}
	async close(): Promise<void> {}
}

const fakeDriver: Driver = {
	name: 'fake',
	types: {},
	async open(_opts: DriverOptions): Promise<Connection> {
		return new FakeConnection();
	},
};

const fakeDriverOptions: DriverOptions = {
	credential: { kind: 'integrated' },
	transport: { host: 'db.local' },
};

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
			driver: fakeDriver,
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
				return new FakeConnection();
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
			driver: fakeDriver,
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
			driver: fakeDriver,
			driverOptions: fakeDriverOptions,
			bindQueryable,
		});
		const pooled = await pool.acquire();
		await pooled.release();
		assert.equal(pool.state, 'open');
	});
});
