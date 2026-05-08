// Tests for `sql.acquire()` + `ReservedConn` (ADR-0006).
//
// `sql.acquire()` returns a chainable builder that resolves (on
// `await`) to a `ReservedConn` — a callable SQL tag pinned to a
// single connection from the pool, plus an explicit `release()`
// method and `Symbol.asyncDispose` for `await using`.
//
// The pinned connection enables session-scoped state (temp tables,
// SET options) that pool-bound queries can't safely use, because
// pool-bound calls aren't guaranteed to land on the same connection.
//
// Concurrency on a pinned connection is queued internally — multiple
// concurrent queries on the same `ReservedConn` serialize FIFO,
// matching the ADR's "`Promise.all` always works" guarantee.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	type Connection,
	type ConnectionEvents,
	type ExecuteRequest,
	type Pool,
	type PooledConnection,
	type PoolStats,
	type PrepareRequest,
	type PreparedHandle,
	type ResultEvent,
	makePoolBoundSqlTag,
} from '../../src/index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface ConnLog {
	executes: ExecuteRequest[]
	executeSignals: (AbortSignal | undefined)[]
	closed: boolean
}

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id = 'conn_test_1';
	readonly log: ConnLog = { executes: [], executeSignals: [], closed: false };
	#scripted: ResultEvent[][] | undefined;
	#callIndex = 0;
	// Override hook for tests that need bespoke execute behaviour (e.g.
	// failing first call). Set this BEFORE running queries.
	executeOverride?: (req: ExecuteRequest, signal?: AbortSignal) => AsyncIterable<ResultEvent>;

	constructor(scriptedEvents?: ResultEvent[][]) {
		super();
		this.#scripted = scriptedEvents;
	}

	execute(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
		this.log.executes.push(req);
		this.log.executeSignals.push(signal);
		if (this.executeOverride !== undefined) {
			return this.executeOverride(req, signal);
		}
		const events = this.#scripted?.[this.#callIndex] ?? [{ kind: 'done' as const }];
		this.#callIndex++;
		return (async function* () {
			for (const e of events) yield e;
		})();
	}
	async beginTransaction(): Promise<void> { /* */ }
	async commit(): Promise<void> { /* */ }
	async rollback(): Promise<void> { /* */ }
	async savepoint(): Promise<void> { /* */ }
	async rollbackToSavepoint(): Promise<void> { /* */ }
	async prepare(_req: PrepareRequest): Promise<PreparedHandle> {
		return { id: 'prep_1', execute() { return (async function* () { yield { kind: 'done' as const }; })(); }, async unprepare() { /* */ } } as unknown as PreparedHandle;
	}
	async bulkLoad(): Promise<{ rowsAffected: number }> { return { rowsAffected: 0 }; }
	async reset(): Promise<void> { /* */ }
	async ping(): Promise<void> { /* */ }
	async close(): Promise<void> { this.log.closed = true; }
}

const makeFakeConnection = (
	scriptedEvents?: ResultEvent[][],
): { conn: FakeConnection; log: ConnLog } => {
	const conn = new FakeConnection(scriptedEvents);
	return { conn, log: conn.log };
};

interface PoolLog {
	acquires: number
	acquireSignals: (AbortSignal | undefined)[]
	releases: number
	destroys: number
}

const makeFakePool = (
	conn: Connection,
): { pool: Pool; log: PoolLog } => {
	const log: PoolLog = { acquires: 0, acquireSignals: [], releases: 0, destroys: 0 };
	let inUse = false;
	const stats: PoolStats = { size: 1, available: 1, inUse: 0, pending: 0 };

	const pool: Pool = {
		state: 'open',
		stats,
		async acquire(signal) {
			log.acquires++;
			log.acquireSignals.push(signal);
			signal?.throwIfAborted();
			if (inUse) {
				throw new Error('FakePool only supports one acquire at a time');
			}
			inUse = true;
			const pooled: PooledConnection = {
				connection: conn,
				async release() {
					if (!inUse) return;
					inUse = false;
					log.releases++;
				},
				async destroy() {
					inUse = false;
					log.destroys++;
				},
				async [Symbol.asyncDispose]() {
					await pooled.release();
				},
			};
			return pooled;
		},
		async drain() { /* */ },
		async destroy() { /* */ },
	};
	return { pool, log };
};

// Build a pool-bound tag rooted at the fake pool — same wiring the
// Client uses (poolRunner + the pool's acquire), without going through
// the full Client lifecycle.
const makePool = (
	scriptedEvents?: ResultEvent[][],
) => {
	const { conn, log: connLog } = makeFakeConnection(scriptedEvents);
	const { pool, log: poolLog } = makeFakePool(conn);
	const sql = makePoolBoundSqlTag(
		{
			run(req, signal) {
				return (async function* () {
					await using pooled = await pool.acquire(signal);
					for await (const ev of pooled.connection.execute(req, signal)) {
						yield ev;
					}
				})();
			},
		},
		(signal) => pool.acquire(signal),
	);
	return { sql, pool, connLog, poolLog };
};

// ─── sql.acquire() — builder + ReservedConn shape ──────────────────────────

describe('sql.acquire() — builder shape', () => {
	test('await sql.acquire() resolves to a ReservedConn (callable + .unsafe + .release)', async () => {
		const { sql, poolLog } = makePool();
		const conn = await sql.acquire();
		assert.equal(typeof conn, 'function');
		assert.equal(typeof conn.unsafe, 'function');
		assert.equal(typeof conn.release, 'function');
		assert.equal(typeof conn[Symbol.asyncDispose], 'function');
		assert.equal(poolLog.acquires, 1);
		await conn.release();
	});

	test('builder is lazy — calling sql.acquire() does NOT pre-acquire', () => {
		const { sql, poolLog } = makePool();
		sql.acquire();  // Build only; do not await.
		assert.equal(poolLog.acquires, 0, 'no acquire until builder is awaited');
	});

	test('.signal(s) is chainable; the signal threads through to pool.acquire()', async () => {
		const { sql, poolLog } = makePool();
		const ac = new AbortController();
		const conn = await sql.acquire().signal(ac.signal);
		assert.equal(poolLog.acquires, 1);
		assert.equal(poolLog.acquireSignals[0], ac.signal);
		await conn.release();
	});

	test('.signal() returns the same builder (fluent)', () => {
		const { sql } = makePool();
		const builder = sql.acquire();
		const ac = new AbortController();
		assert.equal(builder.signal(ac.signal), builder);
	});

	test('aborted signal rejects the builder before acquire', async () => {
		const { sql, poolLog } = makePool();
		const ac = new AbortController();
		ac.abort(new Error('caller cancelled'));
		await assert.rejects(
			async () => { await sql.acquire().signal(ac.signal); },
			/caller cancelled/,
		);
		// pool.acquire() ran but rejected via throwIfAborted.
		assert.equal(poolLog.acquires, 1);
	});

	test('.signal() after the builder has been awaited throws TypeError', async () => {
		const { sql } = makePool();
		const builder = sql.acquire();
		const conn = await builder;
		try {
			assert.throws(() => builder.signal(new AbortController().signal), TypeError);
		} finally {
			await conn.release();
		}
	});
});

// ─── ReservedConn — pinned connection behaviour ─────────────────────────────

describe('ReservedConn — pinned behaviour', () => {
	test('queries on the ReservedConn execute against the held connection (no extra acquires)', async () => {
		const { sql, connLog, poolLog } = makePool();
		const conn = await sql.acquire();
		try {
			await conn`SELECT 1`;
			await conn`SELECT 2`;
			await conn`SELECT 3`;
		} finally {
			await conn.release();
		}
		// Only one acquire (the initial pin); three execute calls on the
		// pinned connection.
		assert.equal(poolLog.acquires, 1);
		assert.equal(connLog.executes.length, 3);
	});

	test('release() returns the connection to the pool exactly once', async () => {
		const { sql, poolLog } = makePool();
		const conn = await sql.acquire();
		await conn.release();
		assert.equal(poolLog.releases, 1);
		// Idempotent — second call no-ops.
		await conn.release();
		assert.equal(poolLog.releases, 1);
	});

	test('await using disposes the ReservedConn (releases the connection)', async () => {
		const { sql, poolLog } = makePool();
		{
			await using _conn = await sql.acquire();
			// scope exit triggers Symbol.asyncDispose
		}
		assert.equal(poolLog.releases, 1);
	});

	test('queries after release() throw TypeError', async () => {
		const { sql } = makePool();
		const conn = await sql.acquire();
		await conn.release();
		assert.throws(() => conn`SELECT 1`, TypeError);
		assert.throws(() => conn.unsafe('SELECT 1'), TypeError);
	});

	test('.unsafe() works on a ReservedConn', async () => {
		const { sql, connLog } = makePool();
		const conn = await sql.acquire();
		try {
			await conn.unsafe('SELECT * FROM t WHERE id = @id', { id: 7 });
			assert.equal(connLog.executes[0]?.sql, 'SELECT * FROM t WHERE id = @id');
			assert.deepEqual(connLog.executes[0]?.params, [{ name: 'id', value: 7 }]);
		} finally {
			await conn.release();
		}
	});

	test('released flag reflects state', async () => {
		const { sql } = makePool();
		const conn = await sql.acquire();
		assert.equal(conn.released, false);
		await conn.release();
		assert.equal(conn.released, true);
	});
});

// ─── ReservedConn — concurrency (FIFO serialisation) ────────────────────────

describe('ReservedConn — concurrent queries serialise FIFO', () => {
	test('Promise.all of three queries on the same ReservedConn runs them in order', async () => {
		// Three scripted result sets — each query gets its own response,
		// ordered. The pinned runner serialises so each query sees the
		// scripted set positioned by its FIFO order.
		const events: ResultEvent[][] = [
			[
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [1] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			],
			[
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [2] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			],
			[
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [3] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			],
		];
		const { sql, connLog } = makePool(events);
		const conn = await sql.acquire();
		try {
			const [a, b, c] = await Promise.all([
				conn<{ n: number }>`SELECT 1 AS n`,
				conn<{ n: number }>`SELECT 2 AS n`,
				conn<{ n: number }>`SELECT 3 AS n`,
			]);
			// Order matters — FIFO on the pinned connection.
			assert.deepEqual(a, [{ n: 1 }]);
			assert.deepEqual(b, [{ n: 2 }]);
			assert.deepEqual(c, [{ n: 3 }]);
			assert.deepEqual(
				connLog.executes.map((r) => r.sql),
				['SELECT 1 AS n', 'SELECT 2 AS n', 'SELECT 3 AS n'],
			);
		} finally {
			await conn.release();
		}
	});

	test('a failing query does not poison the queue — subsequent queries proceed', async () => {
		// First query errors; second and third should still run on the
		// shared connection.
		const events: ResultEvent[][] = [
			[],  // first will error before any events are read; we'll override
			[
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [42] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			],
		];
		const { conn: connBackend, log: connLog } = makeFakeConnection();
		// Override execute to throw on first call.
		let call = 0;
		connBackend.execute = (req, _sig) => {
			connLog.executes.push(req);
			const idx = call++;
			return (async function* () {
				if (idx === 0) {
					throw new Error('first failed');
				}
				const evs = events[idx];
				if (evs !== undefined) {
					for (const e of evs) yield e;
				}
			})();
		};
		const { pool } = makeFakePool(connBackend);
		const sql = makePoolBoundSqlTag(
			{
				run(req, signal) {
					return (async function* () {
						await using pooled = await pool.acquire(signal);
						for await (const ev of pooled.connection.execute(req, signal)) {
							yield ev;
						}
					})();
				},
			},
			(signal) => pool.acquire(signal),
		);
		const c = await sql.acquire();
		try {
			const failPromise = c`SELECT BAD`;
			const okPromise = c<{ n: number }>`SELECT 42 AS n`;
			// `failPromise` is a Query — wrap in async lambda for rejects.
			await assert.rejects(async () => { await failPromise; }, /first failed/);
			const rows = await okPromise;
			assert.deepEqual(rows, [{ n: 42 }]);
		} finally {
			await c.release();
		}
	});
});

// ─── PoolBoundSqlTag — only the pool-bound tag has .acquire ────────────────

describe('PoolBoundSqlTag — surface', () => {
	test('inherits the base SqlTag callable + .unsafe', async () => {
		const { sql, connLog } = makePool();
		await sql`SELECT 1`;
		await sql.unsafe('SELECT 2');
		assert.equal(connLog.executes.length, 2);
		assert.equal(connLog.executes[0]?.sql, 'SELECT 1');
		assert.equal(connLog.executes[1]?.sql, 'SELECT 2');
	});

	test('a ReservedConn does NOT carry .acquire (no nested acquire)', async () => {
		const { sql } = makePool();
		const conn = await sql.acquire();
		try {
			// `conn` is a base SqlTag (callable + .unsafe), not a
			// PoolBoundSqlTag. `.acquire` is absent at runtime AND the
			// type does not declare it.
			assert.equal('acquire' in conn, false);
		} finally {
			await conn.release();
		}
	});
});
