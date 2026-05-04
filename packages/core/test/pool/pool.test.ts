import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type {
	Connection,
	ConnectionEvents,
	ExecuteRequest,
	Pool,
	PooledConnection,
	PoolState,
	PoolStats,
	ResultEvent,
} from '../../src/index.js';

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id = 'conn_pool_1';
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

class FakePooledConnection implements PooledConnection {
	readonly connection: Connection = new FakeConnection();
	released = false;
	destroyed = false;
	async release(): Promise<void> {
		this.released = true;
	}
	async destroy(): Promise<void> {
		this.destroyed = true;
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}
}

class FakePool implements Pool {
	#state: PoolState = 'open';
	#stats: PoolStats = { size: 0, available: 0, inUse: 0, pending: 0 };
	get state(): PoolState {
		return this.#state;
	}
	get stats(): PoolStats {
		return this.#stats;
	}
	async acquire(_signal?: AbortSignal): Promise<PooledConnection> {
		if (this.#state !== 'open') {
			throw new Error(`cannot acquire in state ${this.#state}`);
		}
		return new FakePooledConnection();
	}
	async drain(): Promise<void> {
		this.#state = 'draining';
	}
	async destroy(): Promise<void> {
		this.#state = 'destroyed';
	}
}

describe('Pool', () => {
	test('implementable by a fake adapter', async () => {
		const pool = new FakePool();
		assert.equal(pool.state, 'open');

		const pooled = await pool.acquire();
		assert.equal(pooled.connection.id, 'conn_pool_1');

		await pooled.release();
		assert.equal((pooled as FakePooledConnection).released, true);
	});

	test('state transitions through drain and destroy', async () => {
		const pool = new FakePool();
		assert.equal(pool.state, 'open');

		await pool.drain();
		assert.equal(pool.state, 'draining');

		await pool.destroy();
		assert.equal(pool.state, 'destroyed');
	});

	test('acquire rejects once the pool has been drained', async () => {
		const pool = new FakePool();
		await pool.drain();
		await assert.rejects(() => pool.acquire(), /cannot acquire/);
	});

	test('acquire honours an already-aborted signal via the adapter', async () => {
		class AbortingPool extends FakePool {
			override async acquire(
				signal?: AbortSignal,
			): Promise<PooledConnection> {
				signal?.throwIfAborted();
				return super.acquire(signal);
			}
		}
		const pool = new AbortingPool();
		const ac = new AbortController();
		ac.abort(new Error('caller cancelled'));
		await assert.rejects(() => pool.acquire(ac.signal), /caller cancelled/);
	});
});

describe('PooledConnection', () => {
	test('supports AsyncDisposable (Symbol.asyncDispose)', async () => {
		const pool = new FakePool();
		let captured: FakePooledConnection | undefined;
		{
			await using pooled = (await pool.acquire()) as FakePooledConnection;
			captured = pooled;
			assert.equal(pooled.released, false);
		}
		assert.equal(captured?.released, true);
	});

	test('destroy() marks connection broken without releasing', async () => {
		const pool = new FakePool();
		const pooled = (await pool.acquire()) as FakePooledConnection;
		await pooled.destroy();
		assert.equal(pooled.destroyed, true);
		assert.equal(pooled.released, false);
	});
});
