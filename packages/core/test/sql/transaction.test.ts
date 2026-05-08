// Tests for `sql.transaction()` + `Transaction` (ADR-0006).
//
// `sql.transaction()` reserves a connection, issues BEGIN TRANSACTION
// with the resolved isolation level, and returns a `Transaction` —
// callable + `.unsafe` + `.commit` / `.rollback` / `.savepoint` +
// `Symbol.asyncDispose`. Disposal default is rollback if neither
// commit nor rollback was called.
//
// Isolation level resolution: per-call override > client-level
// default > library default ('read committed').

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	type Connection,
	type ConnectionEvents,
	type ExecuteRequest,
	type IsolationLevel,
	type PrepareRequest,
	type PreparedHandle,
	type ResultEvent,
	type TxOptions,
	makePoolBoundSqlTag,
} from '../../src/index.js';
import {
	type Pool,
	type PooledConnection,
	type PoolStats,
} from '../../src/index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface ConnLog {
	executes: ExecuteRequest[]
	beginCalls: TxOptions[]
	commitCalls: number
	rollbackCalls: number
	savepointCalls: string[]
	rollbackToSavepointCalls: string[]
}

class FakeConnection extends EventEmitter<ConnectionEvents> implements Connection {
	readonly id = 'conn_tx_1';
	readonly log: ConnLog = {
		executes: [],
		beginCalls: [],
		commitCalls: 0,
		rollbackCalls: 0,
		savepointCalls: [],
		rollbackToSavepointCalls: [],
	};
	beginShouldFail?: Error;

	execute(req: ExecuteRequest): AsyncIterable<ResultEvent> {
		this.log.executes.push(req);
		return (async function* () {
			yield { kind: 'done' as const };
		})();
	}
	async beginTransaction(opts?: TxOptions): Promise<void> {
		this.log.beginCalls.push(opts ?? {});
		if (this.beginShouldFail !== undefined) throw this.beginShouldFail;
	}
	async commit(): Promise<void> { this.log.commitCalls++; }
	async rollback(): Promise<void> { this.log.rollbackCalls++; }
	async savepoint(name: string): Promise<void> { this.log.savepointCalls.push(name); }
	async rollbackToSavepoint(name: string): Promise<void> {
		this.log.rollbackToSavepointCalls.push(name);
	}
	async prepare(_req: PrepareRequest): Promise<PreparedHandle> {
		return { id: 'p1', execute() { return (async function* () { yield { kind: 'done' as const }; })(); }, async unprepare() { /* */ } } as unknown as PreparedHandle;
	}
	async bulkLoad(): Promise<{ rowsAffected: number }> { return { rowsAffected: 0 }; }
	async reset(): Promise<void> { /* */ }
	async ping(): Promise<void> { /* */ }
	async close(): Promise<void> { /* */ }
}

interface PoolLog {
	acquires: number
	releases: number
}

const makeFakePool = (
	conn: FakeConnection,
): { pool: Pool; log: PoolLog } => {
	const log: PoolLog = { acquires: 0, releases: 0 };
	let inUse = false;
	const stats: PoolStats = { size: 1, available: 1, inUse: 0, pending: 0 };
	const pool: Pool = {
		state: 'open',
		stats,
		async acquire(signal) {
			log.acquires++;
			signal?.throwIfAborted();
			if (inUse) throw new Error('FakePool only supports one acquire at a time');
			inUse = true;
			const pooled: PooledConnection = {
				connection: conn,
				async release() { if (!inUse) return; inUse = false; log.releases++; },
				async destroy() { inUse = false; log.releases++; },
				async [Symbol.asyncDispose]() { await pooled.release(); },
			};
			return pooled;
		},
		async drain() { /* */ },
		async destroy() { /* */ },
	};
	return { pool, log };
};

const makePool = (defaultLevel?: IsolationLevel) => {
	const conn = new FakeConnection();
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
		defaultLevel,
	);
	return { sql, conn, connLog: conn.log, poolLog };
};

// ─── sql.transaction() — builder + Transaction shape ───────────────────────

describe('sql.transaction() — builder shape', () => {
	test('await sql.transaction() returns a Transaction (callable + lifecycle)', async () => {
		const { sql, connLog, poolLog } = makePool();
		const tx = await sql.transaction();
		try {
			assert.equal(typeof tx, 'function');
			assert.equal(typeof tx.unsafe, 'function');
			assert.equal(typeof tx.commit, 'function');
			assert.equal(typeof tx.rollback, 'function');
			assert.equal(typeof tx.savepoint, 'function');
			assert.equal(typeof tx[Symbol.asyncDispose], 'function');
			assert.equal(tx.state, 'open');
			assert.equal(poolLog.acquires, 1, 'acquire fired during BEGIN');
			assert.equal(connLog.beginCalls.length, 1);
		} finally {
			await tx.rollback();
		}
	});

	test('builder is lazy — no acquire / no BEGIN until awaited', () => {
		const { sql, connLog, poolLog } = makePool();
		sql.transaction();  // build only
		assert.equal(poolLog.acquires, 0);
		assert.equal(connLog.beginCalls.length, 0);
	});

	test('default isolation level is `read committed` when neither client nor per-call override applies', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			assert.equal(connLog.beginCalls[0]?.isolationLevel, 'read committed');
		} finally {
			await tx.rollback();
		}
	});

	test('client-level default is honoured when no per-call override', async () => {
		const { sql, connLog } = makePool('serializable');
		const tx = await sql.transaction();
		try {
			assert.equal(connLog.beginCalls[0]?.isolationLevel, 'serializable');
		} finally {
			await tx.rollback();
		}
	});

	test('per-call .isolationLevel() overrides the client default', async () => {
		const { sql, connLog } = makePool('serializable');
		const tx = await sql.transaction().isolationLevel('snapshot');
		try {
			assert.equal(connLog.beginCalls[0]?.isolationLevel, 'snapshot');
		} finally {
			await tx.rollback();
		}
	});

	test('.signal(s) and .isolationLevel(l) chain (return the same builder)', () => {
		const { sql } = makePool();
		const builder = sql.transaction();
		const ac = new AbortController();
		assert.equal(builder.signal(ac.signal), builder);
		assert.equal(builder.isolationLevel('serializable'), builder);
	});

	test('aborted signal propagates to acquire — builder rejects', async () => {
		const { sql } = makePool();
		const ac = new AbortController();
		ac.abort(new Error('caller cancelled'));
		await assert.rejects(
			async () => { await sql.transaction().signal(ac.signal); },
			/caller cancelled/,
		);
	});

	test('BEGIN failure releases the acquired connection', async () => {
		const { sql, conn, poolLog } = makePool();
		conn.beginShouldFail = new Error('begin denied');
		await assert.rejects(
			async () => { await sql.transaction(); },
			/begin denied/,
		);
		// Acquired but BEGIN errored — release must have fired.
		assert.equal(poolLog.acquires, 1);
		assert.equal(poolLog.releases, 1, 'connection released after BEGIN failure');
	});

	test('.signal() / .isolationLevel() after the builder has been awaited throw', async () => {
		const { sql } = makePool();
		const builder = sql.transaction();
		const tx = await builder;
		try {
			assert.throws(() => builder.signal(new AbortController().signal), TypeError);
			assert.throws(() => builder.isolationLevel('snapshot'), TypeError);
		} finally {
			await tx.rollback();
		}
	});
});

// ─── Transaction — query execution + commit / rollback ─────────────────────

describe('Transaction — query execution', () => {
	test('queries run on the pinned connection (no extra pool acquires)', async () => {
		const { sql, connLog, poolLog } = makePool();
		const tx = await sql.transaction();
		try {
			await tx`SELECT 1`;
			await tx`SELECT 2`;
			await tx`SELECT 3`;
			assert.equal(connLog.executes.length, 3);
			assert.equal(poolLog.acquires, 1, 'one acquire across BEGIN + 3 queries');
		} finally {
			await tx.rollback();
		}
	});

	test('.unsafe() works on a transaction', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.unsafe('SELECT * FROM t WHERE id = @id', { id: 7 });
			assert.equal(connLog.executes[0]?.sql, 'SELECT * FROM t WHERE id = @id');
			assert.deepEqual(connLog.executes[0]?.params, [{ name: 'id', value: 7 }]);
		} finally {
			await tx.rollback();
		}
	});

	test('Promise.all serialises FIFO on the pinned connection', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			await Promise.all([
				tx`SELECT 1`,
				tx`SELECT 2`,
				tx`SELECT 3`,
			]);
			assert.deepEqual(
				connLog.executes.map((r) => r.sql),
				['SELECT 1', 'SELECT 2', 'SELECT 3'],
			);
		} finally {
			await tx.rollback();
		}
	});
});

// ─── Transaction — lifecycle (commit / rollback / dispose) ─────────────────

describe('Transaction — lifecycle', () => {
	test('commit() sends COMMIT and releases the connection', async () => {
		const { sql, connLog, poolLog } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		assert.equal(connLog.commitCalls, 1);
		assert.equal(poolLog.releases, 1);
		assert.equal(tx.state, 'committed');
	});

	test('rollback() sends ROLLBACK and releases the connection', async () => {
		const { sql, connLog, poolLog } = makePool();
		const tx = await sql.transaction();
		await tx.rollback();
		assert.equal(connLog.rollbackCalls, 1);
		assert.equal(poolLog.releases, 1);
		assert.equal(tx.state, 'rolled-back');
	});

	test('commit() is idempotent — second call no-ops', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		await tx.commit();  // no-op
		assert.equal(connLog.commitCalls, 1);
	});

	test('queries after commit() throw TypeError', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		assert.throws(() => tx`SELECT 1`, TypeError);
		assert.throws(() => tx.unsafe('SELECT 1'), TypeError);
	});

	test('await using disposes (rollback default) on scope exit', async () => {
		const { sql, connLog, poolLog } = makePool();
		{
			await using _tx = await sql.transaction();
			// fall off the scope without commit
		}
		assert.equal(connLog.rollbackCalls, 1, 'dispose-without-commit ran rollback');
		assert.equal(poolLog.releases, 1);
	});

	test('await using does NOT roll back if commit() ran inside the scope', async () => {
		const { sql, connLog } = makePool();
		{
			await using tx = await sql.transaction();
			await tx.commit();
		}
		assert.equal(connLog.commitCalls, 1);
		assert.equal(connLog.rollbackCalls, 0, 'no rollback after explicit commit');
	});
});

// ─── Savepoint — tx.savepoint() + lifecycle ────────────────────────────────

describe('Savepoint — lifecycle', () => {
	test('tx.savepoint() returns a Savepoint after SAVE TRANSACTION fires', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			assert.equal(connLog.savepointCalls.length, 1);
			assert.match(connLog.savepointCalls[0]!, /^sp_/);
			assert.equal(sp.state, 'open');
			await sp.release();
		} finally {
			await tx.rollback();
		}
	});

	test('savepoint queries go through the parent tag (FIFO with parent queue)', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp`SELECT 1`;
			await sp`SELECT 2`;
			// All four go through the SAME pinned connection's execute()
			// (BEGIN doesn't show as an execute, but SAVE doesn't either —
			// they're separate driver methods).
			assert.equal(connLog.executes.length, 2);
			await sp.release();
		} finally {
			await tx.rollback();
		}
	});

	test('rollback() rolls back to the savepoint name', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			const name = connLog.savepointCalls[0]!;
			await sp.rollback();
			assert.deepEqual(connLog.rollbackToSavepointCalls, [name]);
			assert.equal(sp.state, 'rolled-back');
		} finally {
			await tx.rollback();
		}
	});

	test('release() is a no-op marker (no driver call)', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.release();
			// Release sends nothing on the wire — SQL Server has no
			// "release savepoint" — but the handle is marked done.
			assert.equal(connLog.rollbackToSavepointCalls.length, 0);
			assert.equal(sp.state, 'released');
			assert.throws(() => sp`SELECT 1`, TypeError);
		} finally {
			await tx.rollback();
		}
	});

	test('await using disposes (rollback default) on scope exit', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			{
				await using _sp = await tx.savepoint();
			}
			assert.equal(connLog.rollbackToSavepointCalls.length, 1);
		} finally {
			await tx.rollback();
		}
	});

	test('release() then dispose() does not re-rollback', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			{
				await using sp = await tx.savepoint();
				await sp.release();
			}
			assert.equal(connLog.rollbackToSavepointCalls.length, 0);
		} finally {
			await tx.rollback();
		}
	});

	test('savepoint() on a committed/rolled-back transaction throws', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		assert.throws(() => tx.savepoint(), TypeError);
	});

	test('savepoint() builder rejects if parent tx settled before await', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		const builder = tx.savepoint();
		await tx.rollback();
		await assert.rejects(async () => { await builder; }, TypeError);
		assert.equal(connLog.savepointCalls.length, 0);
	});

	test('two savepoints on the same tx have unique names', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			const sp2 = await tx.savepoint();
			assert.equal(connLog.savepointCalls.length, 2);
			assert.notEqual(connLog.savepointCalls[0], connLog.savepointCalls[1]);
			await sp1.release();
			await sp2.release();
		} finally {
			await tx.rollback();
		}
	});
});
