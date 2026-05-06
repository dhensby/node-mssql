import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	type Connection,
	type ConnectionEvents,
	type Driver,
	type DriverOptions,
	type ExecuteRequest,
	type Pool,
	type PooledConnection,
	type PoolState,
	type PoolStats,
	poolRunner,
	type ResultEvent,
} from '../../src/index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface ConnLog {
	executes: ExecuteRequest[]
	executeSignals: (AbortSignal | undefined)[]
	resets: number
	closes: number
}

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id = 'conn_pr_1';
	readonly log: ConnLog = {
		executes: [],
		executeSignals: [],
		resets: 0,
		closes: 0,
	};
	#events: ResultEvent[] = [];
	throwOnExecute: Error | null = null;

	scriptEvents(events: ResultEvent[]): void {
		this.#events = events;
	}

	async *execute(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
		this.log.executes.push(req);
		this.log.executeSignals.push(signal);
		if (this.throwOnExecute !== null) throw this.throwOnExecute;
		for (const event of this.#events) {
			yield event;
		}
	}
	async beginTransaction(): Promise<void> {}
	async commit(): Promise<void> {}
	async rollback(): Promise<void> {}
	async savepoint(): Promise<void> {}
	async rollbackToSavepoint(): Promise<void> {}
	async prepare(): Promise<{ id: string }> { return { id: 'prep_1' }; }
	async bulkLoad(): Promise<{ rowsAffected: number }> { return { rowsAffected: 0 }; }
	async reset(): Promise<void> { this.log.resets++; }
	async ping(): Promise<void> {}
	async close(): Promise<void> { this.log.closes++; }
}

interface PoolLog {
	acquires: number
	acquireSignals: (AbortSignal | undefined)[]
	releases: number
	destroys: number
}

class TrackingPool implements Pool {
	readonly log: PoolLog = {
		acquires: 0,
		acquireSignals: [],
		releases: 0,
		destroys: 0,
	};
	readonly conn: FakeConnection;
	#state: PoolState = 'open';

	constructor(conn?: FakeConnection) {
		this.conn = conn ?? new FakeConnection();
	}

	get state(): PoolState { return this.#state; }
	get stats(): PoolStats {
		return { size: 1, available: 1, inUse: 0, pending: 0 };
	}

	async acquire(signal?: AbortSignal): Promise<PooledConnection> {
		this.log.acquires++;
		this.log.acquireSignals.push(signal);
		const log = this.log;
		const conn = this.conn;
		const pooled: PooledConnection = {
			connection: conn,
			release: async () => { log.releases++; },
			destroy: async () => { log.destroys++; },
			[Symbol.asyncDispose]: async () => { log.releases++; },
		};
		return pooled;
	}
	async drain(): Promise<void> { this.#state = 'destroyed'; }
	async destroy(): Promise<void> { this.#state = 'destroyed'; }
}

// ─── poolRunner — basic acquire / execute / release flow ────────────────────

describe('poolRunner — acquire / execute / release', () => {
	test('acquires the pool, runs execute, releases on natural drain', async () => {
		const pool = new TrackingPool();
		pool.conn.scriptEvents([{ kind: 'done' }]);
		const runner = poolRunner(pool);

		const events: ResultEvent[] = [];
		for await (const ev of runner.run({ sql: 'SELECT 1' })) {
			events.push(ev);
		}

		assert.equal(pool.log.acquires, 1);
		assert.equal(pool.log.releases, 1, 'release fired on natural drain');
		assert.equal(pool.conn.log.executes.length, 1);
		assert.deepEqual(events, [{ kind: 'done' }]);
	});

	test('forwards the consumer-supplied signal to pool.acquire and connection.execute', async () => {
		const pool = new TrackingPool();
		pool.conn.scriptEvents([{ kind: 'done' }]);
		const runner = poolRunner(pool);
		const ac = new AbortController();

		for await (const _ of runner.run({ sql: 'SELECT 1' }, ac.signal)) {
			// drain
		}

		assert.equal(pool.log.acquireSignals[0], ac.signal);
		assert.equal(pool.conn.log.executeSignals[0], ac.signal);
	});

	test('forwards the request payload to connection.execute verbatim', async () => {
		const pool = new TrackingPool();
		pool.conn.scriptEvents([{ kind: 'done' }]);
		const runner = poolRunner(pool);
		const req: ExecuteRequest = {
			sql: 'SELECT @p',
			params: [{ name: 'p', value: 42 }],
		};

		for await (const _ of runner.run(req)) {
			// drain
		}

		assert.equal(pool.conn.log.executes[0], req);
	});

	test('releases the connection when the consumer breaks early (iter.return)', async () => {
		const pool = new TrackingPool();
		pool.conn.scriptEvents([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'row', values: [3] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const runner = poolRunner(pool);

		let seen = 0;
		for await (const ev of runner.run({ sql: 'SELECT n FROM t' })) {
			if (ev.kind === 'row') {
				seen++;
				if (seen === 1) break;
			}
		}

		assert.equal(seen, 1, 'broke after first row');
		assert.equal(pool.log.releases, 1, 'release fired despite early break');
	});

	test('releases the connection when execute() throws mid-stream', async () => {
		const pool = new TrackingPool();
		pool.conn.throwOnExecute = new Error('connection lost');
		const runner = poolRunner(pool);

		await assert.rejects(
			async () => {
				for await (const _ of runner.run({ sql: 'SELECT 1' })) {
					// won't reach
				}
			},
			/connection lost/,
		);

		assert.equal(pool.log.releases, 1, 'release fired despite execute throw');
	});
});

// Suppress unused-variable warnings for the FakeConnection path-only Driver.
// (Just to keep the test fixtures co-located even though only the
// connection paths are exercised in this file.)
const _typecheck: Driver = {
	name: '_unused',
	types: {},
	async open(_opts: DriverOptions): Promise<Connection> {
		return new FakeConnection();
	},
};
void _typecheck;
