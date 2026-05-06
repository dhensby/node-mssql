import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	ClientClosedError,
	ClientNotConnectedError,
	type Connection,
	ConnectionError,
	type ConnectionEvents,
	createClient,
	type Driver,
	type DriverOptions,
	type ExecuteRequest,
	type ResultEvent,
} from '../../src/index.js';

// ─── FakeDriver ─────────────────────────────────────────────────────────────

interface FakeConnLog {
	executes: ExecuteRequest[]
	resets: number
	closes: number
}

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id: string;
	readonly log: FakeConnLog = { executes: [], resets: 0, closes: 0 };
	#scriptedFor: ((req: ExecuteRequest) => ResultEvent[]) | null = null;

	constructor(id = 'conn_test') {
		super();
		this.id = id;
	}

	scriptResponse(fn: (req: ExecuteRequest) => ResultEvent[]): void {
		this.#scriptedFor = fn;
	}

	async *execute(req: ExecuteRequest): AsyncIterable<ResultEvent> {
		this.log.executes.push(req);
		const events = this.#scriptedFor?.(req) ?? [{ kind: 'done' satisfies ResultEvent['kind'] } as ResultEvent];
		for (const ev of events) {
			yield ev;
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

interface FakeDriverLog {
	opens: number
	openOptions: DriverOptions[]
}

const buildFakeDriver = (
	connectionFactory: () => FakeConnection = () => new FakeConnection(),
): { driver: Driver; log: FakeDriverLog; lastConn: () => FakeConnection | null } => {
	const log: FakeDriverLog = { opens: 0, openOptions: [] };
	let lastConn: FakeConnection | null = null;
	const driver: Driver = {
		name: 'fake',
		types: {},
		async open(opts) {
			log.opens++;
			log.openOptions.push(opts);
			lastConn = connectionFactory();
			return lastConn;
		},
	};
	return { driver, log, lastConn: () => lastConn };
};

const baseConfig = {
	credential: { kind: 'integrated' as const },
	transport: { host: 'db.local' },
};

// ─── Construction ───────────────────────────────────────────────────────────

describe('Client — construction', () => {
	test('createClient is synchronous; no driver.open() until connect()', () => {
		const { driver, log } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		assert.equal(client.state, 'pending');
		assert.equal(log.opens, 0, 'driver.open not called at construction');
	});

	test('exposes a `sql` tagged-template callable from construction', () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		assert.equal(typeof client.sql, 'function');
	});
});

// ─── connect() lifecycle ────────────────────────────────────────────────────

describe('Client.connect()', () => {
	test('opens a connection eagerly and transitions state pending → open', async () => {
		const { driver, log } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		assert.equal(client.state, 'open');
		assert.equal(log.opens, 1, 'driver.open called once during connect()');
	});

	test('threads the credential + transport through to driver.open()', async () => {
		const { driver, log } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		const opts = log.openOptions[0];
		assert.deepEqual(opts?.credential, baseConfig.credential);
		assert.deepEqual(opts?.transport, baseConfig.transport);
	});

	test('repeated connect() calls during a single in-flight attempt return the same Promise', () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		const p1 = client.connect();
		const p2 = client.connect();
		assert.equal(p1, p2);
	});

	test('connect() called when already open is a no-op', async () => {
		const { driver, log } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.connect();
		assert.equal(client.state, 'open');
		assert.equal(log.opens, 1, 'no second open');
	});

	test('connect() failure transitions state to destroyed (terminal) and surfaces the error', async () => {
		const driver: Driver = {
			name: 'fake',
			types: {},
			async open(): Promise<Connection> {
				throw new ConnectionError('auth failed');
			},
		};
		const client = createClient({ driver, ...baseConfig });
		await assert.rejects(() => client.connect(), ConnectionError);
		assert.equal(client.state, 'destroyed');
	});

	test('connect() against a destroyed client rejects with ClientClosedError', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.destroy();
		await assert.rejects(
			() => client.connect(),
			(err: unknown) => {
				assert.ok(err instanceof ClientClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);
	});
});

// ─── Query gating by client state ───────────────────────────────────────────

describe('Client — query state gating', () => {
	test('queries before connect() throw ClientNotConnectedError on terminal', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await assert.rejects(
			async () => { await client.sql`SELECT 1`; },
			ClientNotConnectedError,
		);
	});

	test('queries after close() throw ClientClosedError', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.close();
		await assert.rejects(
			async () => { await client.sql`SELECT 1`; },
			(err: unknown) => {
				assert.ok(err instanceof ClientClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);
	});

	test('queries after destroy() throw ClientClosedError', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.destroy();
		await assert.rejects(
			async () => { await client.sql`SELECT 1`; },
			(err: unknown) => {
				assert.ok(err instanceof ClientClosedError);
				assert.equal(err.state, 'destroyed');
				return true;
			},
		);
	});
});

// ─── close() lifecycle ──────────────────────────────────────────────────────

describe('Client.close()', () => {
	test('drains the pool and transitions state to destroyed', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.close();
		assert.equal(client.state, 'destroyed');
	});

	test('repeated close() calls return the same Promise', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		const p1 = client.close();
		const p2 = client.close();
		assert.equal(p1, p2);
		await p1;
	});

	test('close() on a never-connected client just transitions to destroyed', async () => {
		const { driver, log } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.close();
		assert.equal(client.state, 'destroyed');
		assert.equal(log.opens, 0, 'driver.open never called');
	});

	test('close() on a destroyed client is idempotent (resolved Promise, no error)', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.destroy();
		await client.close();
		assert.equal(client.state, 'destroyed');
	});
});

// ─── destroy() lifecycle ────────────────────────────────────────────────────

describe('Client.destroy()', () => {
	test('force-closes the pool and transitions state to destroyed', async () => {
		const { driver, lastConn } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.destroy();
		assert.equal(client.state, 'destroyed');
		assert.equal(lastConn()?.log.closes, 1, 'underlying connection closed');
	});

	test('repeated destroy() calls return the same Promise', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		const p1 = client.destroy();
		const p2 = client.destroy();
		assert.equal(p1, p2);
	});

	test('destroy() concurrent with close() short-circuits the drain', async () => {
		const { driver } = buildFakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		// Start a close() (state → 'draining' synchronously).
		const closePromise = client.close();
		// Force-destroy concurrently.
		const destroyPromise = client.destroy();

		await Promise.all([closePromise, destroyPromise]);
		assert.equal(client.state, 'destroyed');
	});
});

// ─── End-to-end: sql tag → Query → poolRunner → SingleConnectionPool → FakeDriver ───

describe('Client — end-to-end smoke', () => {
	test('await client.sql`SELECT 1` returns rows from the FakeDriver', async () => {
		const { driver } = buildFakeDriver(() => {
			const conn = new FakeConnection();
			conn.scriptResponse((_req) => [
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [1] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			]);
			return conn;
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
		assert.deepEqual(rows, [{ n: 1 }]);

		await client.close();
	});

	test('parameter binding round-trips through the runner', async () => {
		let captured: ExecuteRequest | null = null;
		const { driver } = buildFakeDriver(() => {
			const conn = new FakeConnection();
			conn.scriptResponse((req) => {
				captured = req;
				return [
					{ kind: 'metadata', columns: [{ name: 'x' }] },
					{ kind: 'row', values: [req.params?.[0]?.value] },
					{ kind: 'rowsetEnd', rowsAffected: 1 },
					{ kind: 'done' },
				];
			});
			return conn;
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const rows = await client.sql<{ x: number }>`SELECT ${42} AS x`;
		assert.deepEqual(rows, [{ x: 42 }]);
		assert.equal(captured!.sql, 'SELECT @p0 AS x');
		assert.deepEqual(captured!.params, [{ name: 'p0', value: 42 }]);

		await client.close();
	});

	test('multiple sequential queries reuse the SingleConnectionPool connection', async () => {
		const { driver, log: driverLog, lastConn } = buildFakeDriver(() => {
			const conn = new FakeConnection();
			conn.scriptResponse((_req) => [
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [1] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			]);
			return conn;
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		await client.sql`SELECT 1`;
		await client.sql`SELECT 1`;
		await client.sql`SELECT 1`;

		assert.equal(driverLog.opens, 1, 'driver.open called only once');
		const conn = lastConn();
		assert.equal(conn?.log.executes.length, 3, '3 executes on same connection');
		// reset() runs on every release. Each query is one acquire+release;
		// `client.connect()`'s eager-validate is a fourth (acquire-and-immediately-release).
		assert.equal(conn?.log.resets, 4, 'reset called per release (connect + 3 queries)');

		await client.close();
	});
});
