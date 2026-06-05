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
import {
	type ResultEvent,
	makePoolBoundSqlTag,
} from '../../src/index.js';
import { fakeConnection, fakePool } from '../support/fakes.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

// Build a pool-bound tag rooted at the fake pool — same wiring the
// Client uses (poolRunner + the pool's acquire), without going through
// the full Client lifecycle.
const makePool = (
	scriptedEvents?: ResultEvent[][],
) => {
	let callIndex = 0;
	const conn = fakeConnection(
		scriptedEvents !== undefined
			? { execute: () => scriptedEvents[callIndex++] ?? [{ kind: 'done' }] }
			: undefined,
	);
	const { pool, release } = fakePool(conn);
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
	return { sql, conn, pool, release };
};

// ─── sql.acquire() — builder + ReservedConn shape ──────────────────────────

describe('sql.acquire() — builder shape', () => {
	test('await sql.acquire() resolves to a ReservedConn (callable + .unsafe + .release)', async () => {
		const { sql, pool } = makePool();
		const conn = await sql.acquire();
		assert.equal(typeof conn, 'function');
		assert.equal(typeof conn.unsafe, 'function');
		assert.equal(typeof conn.release, 'function');
		assert.equal(typeof conn[Symbol.asyncDispose], 'function');
		assert.equal(pool.acquire.mock.callCount(), 1);
		await conn.release();
	});

	test('builder is lazy — calling sql.acquire() does NOT pre-acquire', () => {
		const { sql, pool } = makePool();
		sql.acquire();  // Build only; do not await.
		assert.equal(pool.acquire.mock.callCount(), 0, 'there should be no acquire until the builder is awaited');
	});

	test('.signal(s) is chainable; the signal threads through to pool.acquire()', async () => {
		const { sql, pool } = makePool();
		const ac = new AbortController();
		const conn = await sql.acquire().signal(ac.signal);
		assert.equal(pool.acquire.mock.callCount(), 1);
		assert.equal(pool.acquire.mock.calls[0]!.arguments[0], ac.signal);
		await conn.release();
	});

	test('.signal() returns the same builder (fluent)', () => {
		const { sql } = makePool();
		const builder = sql.acquire();
		const ac = new AbortController();
		assert.equal(builder.signal(ac.signal), builder);
	});

	test('aborted signal rejects the builder before acquire', async () => {
		const { sql, pool } = makePool();
		const ac = new AbortController();
		ac.abort(new Error('caller cancelled'));
		await assert.rejects(
			async () => { await sql.acquire().signal(ac.signal); },
			/caller cancelled/,
		);
		// pool.acquire() ran but rejected via throwIfAborted.
		assert.equal(pool.acquire.mock.callCount(), 1);
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
		const { sql, conn: backend, pool } = makePool();
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
		assert.equal(pool.acquire.mock.callCount(), 1);
		assert.equal(backend.execute.mock.callCount(), 3);
	});

	test('release() returns the connection to the pool exactly once', async () => {
		const { sql, release } = makePool();
		const conn = await sql.acquire();
		await conn.release();
		assert.equal(release.mock.callCount(), 1);
		// Idempotent — second call no-ops.
		await conn.release();
		assert.equal(release.mock.callCount(), 1);
	});

	test('await using disposes the ReservedConn (releases the connection)', async () => {
		const { sql, release } = makePool();
		{
			await using _conn = await sql.acquire();
			// scope exit triggers Symbol.asyncDispose
		}
		assert.equal(release.mock.callCount(), 1);
	});

	test('queries after release() throw TypeError', async () => {
		const { sql } = makePool();
		const conn = await sql.acquire();
		await conn.release();
		assert.throws(() => conn`SELECT 1`, TypeError);
		assert.throws(() => conn.unsafe('SELECT 1'), TypeError);
	});

	test('.unsafe() works on a ReservedConn', async () => {
		const { sql, conn: backend } = makePool();
		const conn = await sql.acquire();
		try {
			await conn.unsafe('SELECT * FROM t WHERE id = @id', { id: 7 });
			assert.equal(backend.execute.mock.calls[0]!.arguments[0].sql, 'SELECT * FROM t WHERE id = @id');
			assert.deepEqual(backend.execute.mock.calls[0]!.arguments[0].params, [{ name: 'id', value: 7 }]);
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
		const { sql, conn: backend } = makePool(events);
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
				backend.execute.mock.calls.map((call) => call.arguments[0].sql),
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
			[],  // first will error before any events are read
			[
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [42] },
				{ kind: 'rowsetEnd', rowsAffected: 1 },
				{ kind: 'done' },
			],
		];
		// execute throws on the first call, serves the scripted set after.
		let call = 0;
		const backend = fakeConnection({
			execute: () => {
				const idx = call++;
				if (idx === 0) {
					throw new Error('first failed');
				}
				return events[idx] ?? [];
			},
		});
		const { pool } = fakePool(backend);
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
		const { sql, conn: backend } = makePool();
		await sql`SELECT 1`;
		await sql.unsafe('SELECT 2');
		assert.equal(backend.execute.mock.callCount(), 2);
		assert.equal(backend.execute.mock.calls[0]!.arguments[0].sql, 'SELECT 1');
		assert.equal(backend.execute.mock.calls[1]!.arguments[0].sql, 'SELECT 2');
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

// ─── ReservedConn.transaction() — transaction on a held connection ─────────

describe('ReservedConn — .transaction()', () => {
	test('opens a transaction on the held connection (BEGIN on the same conn)', async () => {
		const { sql, conn: backend, pool } = makePool();
		await using conn = await sql.acquire();
		const tx = await conn.transaction();
		try {
			await tx`SELECT 1`;
			assert.equal(backend.beginTransaction.mock.callCount(), 1, 'BEGIN should fire on the held connection');
			assert.equal(pool.acquire.mock.callCount(), 1, 'there should be no second acquire (reused the held connection)');
		} finally {
			await tx.commit();
		}
	});

	test('committing the transaction does NOT release the connection (the ReservedConn owns it)', async () => {
		const { sql, conn: backend, release } = makePool();
		const conn = await sql.acquire();
		const tx = await conn.transaction();
		await tx.commit();
		assert.equal(backend.commit.mock.callCount(), 1);
		assert.equal(release.mock.callCount(), 0, 'commit should not return the connection to the pool');
		// The ReservedConn is still usable after the transaction commits.
		await conn`SELECT after-commit`;
		assert.equal(backend.execute.mock.calls.at(-1)!.arguments[0].sql, 'SELECT after-commit');
		// Releasing the ReservedConn is what returns it to the pool.
		await conn.release();
		assert.equal(release.mock.callCount(), 1);
	});

	test('the transaction supports savepoints on the held connection', async () => {
		const { sql } = makePool();
		await using conn = await sql.acquire();
		const tx = await conn.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.rollback();
		} finally {
			await tx.commit();
		}
	});

	test('queries after the ReservedConn is released throw', async () => {
		const { sql } = makePool();
		const conn = await sql.acquire();
		const tx = await conn.transaction();
		await tx.commit();
		await conn.release();
		assert.throws(() => conn`SELECT 1`, TypeError);
	});
});
