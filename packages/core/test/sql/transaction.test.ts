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
	type Savepoint,
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

	// Overlap detector: TDS serves one request per connection at a time, so
	// any wire op that starts while another is in flight is a serialisation
	// bug. Every op holds the connection across one microtask — long enough
	// for a racing caller to be caught instead of silently masked.
	#inFlight: string | null = null;
	#executeGate: Promise<void> | undefined;

	#enter(label: string): void {
		if (this.#inFlight !== null) {
			throw new Error(`overlapping request: ${label} started while ${this.#inFlight} in flight`);
		}
		this.#inFlight = label;
	}
	#exit(): void {
		this.#inFlight = null;
	}

	/** Hold the next `execute()` in flight until the returned fn is called. */
	holdNextExecute(): () => void {
		let release!: () => void;
		this.#executeGate = new Promise<void>((res) => { release = res; });
		return release;
	}

	execute(req: ExecuteRequest): AsyncIterable<ResultEvent> {
		const gate = this.#executeGate;
		this.#executeGate = undefined;
		return this.#runExecute(req, gate);
	}
	async *#runExecute(
		req: ExecuteRequest,
		gate: Promise<void> | undefined,
	): AsyncIterable<ResultEvent> {
		this.#enter('execute');
		try {
			if (gate !== undefined) await gate;
			await Promise.resolve();
			this.log.executes.push(req);
			yield { kind: 'done' as const };
		} finally {
			this.#exit();
		}
	}
	async beginTransaction(opts?: TxOptions): Promise<void> {
		this.#enter('beginTransaction');
		try {
			await Promise.resolve();
			this.log.beginCalls.push(opts ?? {});
			if (this.beginShouldFail !== undefined) throw this.beginShouldFail;
		} finally {
			this.#exit();
		}
	}
	async commit(): Promise<void> {
		this.#enter('commit');
		try { await Promise.resolve(); this.log.commitCalls++; } finally { this.#exit(); }
	}
	async rollback(): Promise<void> {
		this.#enter('rollback');
		try { await Promise.resolve(); this.log.rollbackCalls++; } finally { this.#exit(); }
	}
	async savepoint(name: string): Promise<void> {
		this.#enter('savepoint');
		try { await Promise.resolve(); this.log.savepointCalls.push(name); } finally { this.#exit(); }
	}
	async rollbackToSavepoint(name: string): Promise<void> {
		this.#enter('rollbackToSavepoint');
		try { await Promise.resolve(); this.log.rollbackToSavepointCalls.push(name); } finally { this.#exit(); }
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
			assert.equal(typeof tx.rollbackSavepoint, 'function');
			assert.equal(typeof tx.releaseSavepoint, 'function');
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

// ─── Savepoints — transaction-managed bookmarks ────────────────────────────
//
// `tx.savepoint()` → SAVE TRANSACTION + a thin handle. `sp.rollback()` →
// ROLLBACK TRANSACTION <name> (discard work since the mark). `sp.release()`
// → drop the mark keeping its work (application-layer, no wire op).
// Kept-by-default; `await using sp` disposal releases. Queries run on tx.

describe('Transaction — savepoints', () => {
	test('tx.savepoint() issues SAVE TRANSACTION and returns a handle', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			assert.equal(connLog.savepointCalls.length, 1);
			assert.match(connLog.savepointCalls[0]!, /^sp_[0-9a-f]{10}_\d+$/);
			assert.equal(sp.name, connLog.savepointCalls[0]);
			assert.equal(sp.state, 'active');
			assert.equal(typeof sp.rollback, 'function');
			assert.equal(typeof sp.release, 'function');
			assert.equal(typeof sp[Symbol.asyncDispose], 'function');
		} finally {
			await tx.rollback();
		}
	});

	test('queries run on the transaction (savepoints are markers, not scopes)', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			await tx`SELECT 1`;
			await tx`SELECT 2`;
			assert.equal(connLog.executes.length, 2);
		} finally {
			await tx.rollback();
		}
	});

	test('sp.rollback() issues ROLLBACK TRANSACTION <name> and discards work', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.rollback();
			assert.deepEqual(connLog.rollbackToSavepointCalls, [sp.name]);
			assert.equal(sp.state, 'rolled-back');
		} finally {
			await tx.rollback();
		}
	});

	test('sp.release() drops the mark with NO wire op, keeping work', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.release();
			assert.equal(connLog.rollbackToSavepointCalls.length, 0, 'no ROLLBACK TO — release is app-layer');
			assert.equal(sp.state, 'released');
		} finally {
			await tx.rollback();
		}
	});

	test('await using sp disposal RELEASES (keeps work) — does not roll back', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			let captured: Savepoint | undefined;
			{
				await using sp = await tx.savepoint();
				captured = sp;
			}  // dispose → release
			assert.equal(connLog.rollbackToSavepointCalls.length, 0, 'disposal did not roll back');
			assert.equal(captured.state, 'released');
		} finally {
			await tx.rollback();
		}
	});

	test('await using sp after explicit rollback does not double-settle', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			{
				await using sp = await tx.savepoint();
				await sp.rollback();
			}  // dispose: already spent → no-op
			assert.equal(connLog.rollbackToSavepointCalls.length, 1);
		} finally {
			await tx.rollback();
		}
	});

	test('rollback / release on a spent savepoint throws', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.release();
			await assert.rejects(async () => { await sp.rollback(); }, TypeError);
			await assert.rejects(async () => { await sp.release(); }, TypeError);
		} finally {
			await tx.rollback();
		}
	});

	test('two savepoints have distinct names', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const a = await tx.savepoint();
			const b = await tx.savepoint();
			assert.notEqual(a.name, b.name);
			assert.equal(connLog.savepointCalls.length, 2);
		} finally {
			await tx.rollback();
		}
	});

	test('savepoint methods on a settled transaction throw', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		await assert.rejects(async () => { await tx.savepoint(); }, TypeError);
		await assert.rejects(async () => { await tx.rollbackSavepoint(); }, TypeError);
		await assert.rejects(async () => { await tx.releaseSavepoint(); }, TypeError);
	});
});

// ─── Savepoint stack — rolling back / releasing pops to the mark ───────────

describe('Transaction — savepoint stack', () => {
	test('rolling back to an earlier mark invalidates later marks', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			const sp2 = await tx.savepoint();
			await sp1.rollback();  // ROLLBACK TO sp1 — discards everything after sp1, incl. sp2
			assert.deepEqual(connLog.rollbackToSavepointCalls, [sp1.name]);
			assert.equal(sp1.state, 'rolled-back');
			assert.equal(sp2.state, 'rolled-back', 'sp2 invalidated by the earlier rollback');
			await assert.rejects(async () => { await sp2.rollback(); }, TypeError);
		} finally {
			await tx.rollback();
		}
	});

	test('releasing an earlier mark drops later marks too (keeping work)', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			const sp2 = await tx.savepoint();
			await sp1.release();
			assert.equal(connLog.rollbackToSavepointCalls.length, 0);
			assert.equal(sp1.state, 'released');
			assert.equal(sp2.state, 'released', 'sp2 dropped along with sp1');
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint() rolls back to the most-recent mark', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			const sp2 = await tx.savepoint();
			await tx.rollbackSavepoint();  // no arg → most recent (sp2)
			assert.deepEqual(connLog.rollbackToSavepointCalls, [sp2.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint(name) targets a named mark', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			await tx.savepoint();
			await tx.rollbackSavepoint(sp1.name);
			assert.deepEqual(connLog.rollbackToSavepointCalls, [sp1.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('tx.releaseSavepoint() releases the most-recent mark (no wire op)', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			const sp2 = await tx.savepoint();
			await tx.releaseSavepoint();
			assert.equal(connLog.rollbackToSavepointCalls.length, 0);
			assert.equal(sp2.state, 'released');
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint() with no open savepoint throws', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		try {
			await assert.rejects(async () => { await tx.rollbackSavepoint(); }, TypeError);
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint(unknownName) throws', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			await assert.rejects(async () => { await tx.rollbackSavepoint('sp_does_not_exist'); }, TypeError);
		} finally {
			await tx.rollback();
		}
	});
});

// ─── Settling a transaction clears the savepoint stack in one wire op ──────

describe('Transaction — settling with open savepoints', () => {
	test('commit with open savepoints is one COMMIT (no per-savepoint cascade); marks kept+spent', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.commit();
		assert.equal(connLog.commitCalls, 1);
		assert.equal(connLog.rollbackToSavepointCalls.length, 0, 'no cascade of savepoint rollbacks');
		assert.equal(sp.state, 'released', 'savepoint work kept by the commit');
		await assert.rejects(async () => { await sp.rollback(); }, TypeError);
	});

	test('rollback with open savepoints is one ROLLBACK (no cascade); marks spent', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.rollback();
		assert.equal(connLog.rollbackCalls, 1);
		assert.equal(connLog.rollbackToSavepointCalls.length, 0, 'no cascade of savepoint rollbacks');
		assert.equal(sp.state, 'rolled-back');
	});

	test('disposing a savepoint after its transaction settled is a forgiving no-op', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.commit();
		await sp[Symbol.asyncDispose]();  // must not throw or hit the wire
		assert.equal(connLog.rollbackToSavepointCalls.length, 0);
	});
});

// ─── Concurrency safety — finalisation guard + serialised control ops ──────
//
// The pinned connection serves one request at a time; `FakeConnection`
// rejects overlapping wire ops so an un-serialised regression throws rather
// than passing silently. commit/rollback hold one finalisation promise so
// repeat or racing settles are idempotent and disposal never turns a commit
// into a rollback.

// Drain the microtask queue (one macrotask boundary) — lets every settled
// promise that *can* progress do so, so "did NOT run" assertions are sound.
const drain = (): Promise<void> => new Promise<void>((res) => { setImmediate(res); });

describe('Transaction — concurrency safety', () => {
	test('parallel commit() calls issue exactly one COMMIT', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.commit(), tx.commit(), tx.commit()]);
		assert.equal(connLog.commitCalls, 1, 'only one COMMIT reached the wire');
		assert.equal(tx.state, 'committed');
	});

	test('parallel rollback() calls issue exactly one ROLLBACK', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.rollback(), tx.rollback()]);
		assert.equal(connLog.rollbackCalls, 1);
		assert.equal(tx.state, 'rolled-back');
	});

	test('commit() + rollback() in parallel — first call wins, one wire op', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.commit(), tx.rollback()]);  // commit issued first
		assert.equal(connLog.commitCalls, 1, 'commit (issued first) wins');
		assert.equal(connLog.rollbackCalls, 0, 'no rollback once a settle is in flight');
		assert.equal(tx.state, 'committed');
	});

	test('unawaited commit() + disposal does NOT roll back', async () => {
		const { sql, connLog } = makePool();
		{
			await using tx = await sql.transaction();
			void tx.commit();  // not awaited — disposal must await it, not roll back
		}
		assert.equal(connLog.commitCalls, 1);
		assert.equal(connLog.rollbackCalls, 0, 'disposal did not turn the commit into a rollback');
	});

	test('a query issued after an unawaited commit() is rejected (settling)', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		void tx.commit();  // settling — state still reads "open" until the wire lands
		assert.throws(() => tx`SELECT 1`, TypeError, 'no new work once a settle is in flight');
		await tx.commit();  // drain the in-flight commit
	});

	test('parallel savepoint() calls serialise into ordered, distinct marks', async () => {
		const { sql, connLog } = makePool();
		const tx = await sql.transaction();
		try {
			// No overlap thrown (the fake rejects overlapping wire ops): three
			// SAVEs land sequentially, in call order, with distinct names.
			const [a, b, c] = await Promise.all([
				tx.savepoint(),
				tx.savepoint(),
				tx.savepoint(),
			]);
			assert.equal(connLog.savepointCalls.length, 3);
			assert.equal(new Set([a.name, b.name, c.name]).size, 3, 'distinct marks');
			assert.deepEqual(connLog.savepointCalls, [a.name, b.name, c.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('commit() serialises behind an in-flight query (waits, no overlap)', async () => {
		const { sql, conn, connLog } = makePool();
		const tx = await sql.transaction();
		const release = conn.holdNextExecute();
		const query = tx`SELECT 1`.run();   // enters the connection, held in flight
		await drain();                      // let the query reach the wire
		const committed = tx.commit();
		await drain();                      // give commit every chance to (wrongly) fire
		assert.equal(connLog.commitCalls, 0, 'commit waits for the in-flight query');
		release();                          // let the query finish
		await query;
		await committed;
		assert.equal(connLog.commitCalls, 1, 'commit ran once the query settled');
		assert.equal(connLog.executes.length, 1);
		assert.equal(tx.state, 'committed');
	});
});
