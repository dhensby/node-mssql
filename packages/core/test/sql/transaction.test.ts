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
import {
	type IsolationLevel,
	type Savepoint,
	makePoolBoundSqlTag,
} from '../../src/index.js';
import { fakeConnection, fakePool } from '../support/fakes.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const makePool = (defaultLevel?: IsolationLevel) => {
	// `detectOverlap` models TDS's one-request-per-connection rule: any wire op
	// that starts while another is in flight is a serialisation bug and throws
	// rather than being silently masked. Each op holds the connection across
	// one microtask — long enough for a racing caller to be caught.
	const conn = fakeConnection({ detectOverlap: true });
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
		defaultLevel,
	);
	return { sql, conn, pool, release };
};

// ─── sql.transaction() — builder + Transaction shape ───────────────────────

describe('sql.transaction() — builder shape', () => {
	test('await sql.transaction() returns a Transaction (callable + lifecycle)', async () => {
		const { sql, conn, pool } = makePool();
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
			assert.equal(pool.acquire.mock.callCount(), 1, 'acquire fired during BEGIN');
			assert.equal(conn.beginTransaction.mock.callCount(), 1);
		} finally {
			await tx.rollback();
		}
	});

	test('builder is lazy — no acquire / no BEGIN until awaited', () => {
		const { sql, conn, pool } = makePool();
		sql.transaction();  // build only
		assert.equal(pool.acquire.mock.callCount(), 0);
		assert.equal(conn.beginTransaction.mock.callCount(), 0);
	});

	test('default isolation level is `read committed` when neither client nor per-call override applies', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			assert.equal(conn.beginTransaction.mock.calls[0]?.arguments[0]?.isolationLevel, 'read committed');
		} finally {
			await tx.rollback();
		}
	});

	test('client-level default is honoured when no per-call override', async () => {
		const { sql, conn } = makePool('serializable');
		const tx = await sql.transaction();
		try {
			assert.equal(conn.beginTransaction.mock.calls[0]?.arguments[0]?.isolationLevel, 'serializable');
		} finally {
			await tx.rollback();
		}
	});

	test('per-call .isolationLevel() overrides the client default', async () => {
		const { sql, conn } = makePool('serializable');
		const tx = await sql.transaction().isolationLevel('snapshot');
		try {
			assert.equal(conn.beginTransaction.mock.calls[0]?.arguments[0]?.isolationLevel, 'snapshot');
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
		const { sql, conn, pool, release } = makePool();
		conn.failBegin = new Error('begin denied');
		await assert.rejects(
			async () => { await sql.transaction(); },
			/begin denied/,
		);
		// Acquired but BEGIN errored — release must have fired.
		assert.equal(pool.acquire.mock.callCount(), 1);
		assert.equal(release.mock.callCount(), 1, 'connection released after BEGIN failure');
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
		const { sql, conn, pool } = makePool();
		const tx = await sql.transaction();
		try {
			await tx`SELECT 1`;
			await tx`SELECT 2`;
			await tx`SELECT 3`;
			assert.equal(conn.execute.mock.callCount(), 3);
			assert.equal(pool.acquire.mock.callCount(), 1, 'one acquire across BEGIN + 3 queries');
		} finally {
			await tx.rollback();
		}
	});

	test('.unsafe() works on a transaction', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.unsafe('SELECT * FROM t WHERE id = @id', { id: 7 });
			assert.equal(conn.execute.mock.calls[0]?.arguments[0].sql, 'SELECT * FROM t WHERE id = @id');
			assert.deepEqual(conn.execute.mock.calls[0]?.arguments[0].params, [{ name: 'id', value: 7 }]);
		} finally {
			await tx.rollback();
		}
	});

	test('Promise.all serialises FIFO on the pinned connection', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			await Promise.all([
				tx`SELECT 1`,
				tx`SELECT 2`,
				tx`SELECT 3`,
			]);
			assert.deepEqual(
				conn.execute.mock.calls.map((call) => call.arguments[0].sql),
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
		const { sql, conn, release } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		assert.equal(conn.commit.mock.callCount(), 1);
		assert.equal(release.mock.callCount(), 1);
		assert.equal(tx.state, 'committed');
	});

	test('rollback() sends ROLLBACK and releases the connection', async () => {
		const { sql, conn, release } = makePool();
		const tx = await sql.transaction();
		await tx.rollback();
		assert.equal(conn.rollback.mock.callCount(), 1);
		assert.equal(release.mock.callCount(), 1);
		assert.equal(tx.state, 'rolled-back');
	});

	test('commit() is idempotent — second call no-ops', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		await tx.commit();  // no-op
		assert.equal(conn.commit.mock.callCount(), 1);
	});

	test('queries after commit() throw TypeError', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		await tx.commit();
		assert.throws(() => tx`SELECT 1`, TypeError);
		assert.throws(() => tx.unsafe('SELECT 1'), TypeError);
	});

	test('await using disposes (rollback default) on scope exit', async () => {
		const { sql, conn, release } = makePool();
		{
			await using _tx = await sql.transaction();
			// fall off the scope without commit
		}
		assert.equal(conn.rollback.mock.callCount(), 1, 'dispose-without-commit ran rollback');
		assert.equal(release.mock.callCount(), 1);
	});

	test('await using does NOT roll back if commit() ran inside the scope', async () => {
		const { sql, conn } = makePool();
		{
			await using tx = await sql.transaction();
			await tx.commit();
		}
		assert.equal(conn.commit.mock.callCount(), 1);
		assert.equal(conn.rollback.mock.callCount(), 0, 'no rollback after explicit commit');
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
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			assert.equal(conn.savepoint.mock.callCount(), 1);
			assert.match(conn.savepoint.mock.calls[0]!.arguments[0], /^sp_[0-9a-f]{10}_\d+$/);
			assert.equal(sp.name, conn.savepoint.mock.calls[0]?.arguments[0]);
			assert.equal(sp.state, 'active');
			assert.equal(typeof sp.rollback, 'function');
			assert.equal(typeof sp.release, 'function');
			assert.equal(typeof sp[Symbol.asyncDispose], 'function');
		} finally {
			await tx.rollback();
		}
	});

	test('queries run on the transaction (savepoints are markers, not scopes)', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			await tx`SELECT 1`;
			await tx`SELECT 2`;
			assert.equal(conn.execute.mock.callCount(), 2);
		} finally {
			await tx.rollback();
		}
	});

	test('sp.rollback() issues ROLLBACK TRANSACTION <name> and discards work', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.rollback();
			assert.deepEqual(conn.rollbackToSavepoint.mock.calls.map((call) => call.arguments[0]), [sp.name]);
			assert.equal(sp.state, 'rolled-back');
		} finally {
			await tx.rollback();
		}
	});

	test('sp.release() drops the mark with NO wire op, keeping work', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp = await tx.savepoint();
			await sp.release();
			assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0, 'no ROLLBACK TO — release is app-layer');
			assert.equal(sp.state, 'released');
		} finally {
			await tx.rollback();
		}
	});

	test('await using sp disposal RELEASES (keeps work) — does not roll back', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			let captured: Savepoint | undefined;
			{
				await using sp = await tx.savepoint();
				captured = sp;
			}  // dispose → release
			assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0, 'disposal did not roll back');
			assert.equal(captured.state, 'released');
		} finally {
			await tx.rollback();
		}
	});

	test('await using sp after explicit rollback does not double-settle', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			{
				await using sp = await tx.savepoint();
				await sp.rollback();
			}  // dispose: already spent → no-op
			assert.equal(conn.rollbackToSavepoint.mock.callCount(), 1);
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
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const a = await tx.savepoint();
			const b = await tx.savepoint();
			assert.notEqual(a.name, b.name);
			assert.equal(conn.savepoint.mock.callCount(), 2);
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
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			const sp2 = await tx.savepoint();
			await sp1.rollback();  // ROLLBACK TO sp1 — discards everything after sp1, incl. sp2
			assert.deepEqual(conn.rollbackToSavepoint.mock.calls.map((call) => call.arguments[0]), [sp1.name]);
			assert.equal(sp1.state, 'rolled-back');
			assert.equal(sp2.state, 'rolled-back', 'sp2 invalidated by the earlier rollback');
			await assert.rejects(async () => { await sp2.rollback(); }, TypeError);
		} finally {
			await tx.rollback();
		}
	});

	test('releasing an earlier mark drops later marks too (keeping work)', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			const sp2 = await tx.savepoint();
			await sp1.release();
			assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0);
			assert.equal(sp1.state, 'released');
			assert.equal(sp2.state, 'released', 'sp2 dropped along with sp1');
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint() rolls back to the most-recent mark', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			const sp2 = await tx.savepoint();
			await tx.rollbackSavepoint();  // no arg → most recent (sp2)
			assert.deepEqual(conn.rollbackToSavepoint.mock.calls.map((call) => call.arguments[0]), [sp2.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('tx.rollbackSavepoint(name) targets a named mark', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			const sp1 = await tx.savepoint();
			await tx.savepoint();
			await tx.rollbackSavepoint(sp1.name);
			assert.deepEqual(conn.rollbackToSavepoint.mock.calls.map((call) => call.arguments[0]), [sp1.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('tx.releaseSavepoint() releases the most-recent mark (no wire op)', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			await tx.savepoint();
			const sp2 = await tx.savepoint();
			await tx.releaseSavepoint();
			assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0);
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
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.commit();
		assert.equal(conn.commit.mock.callCount(), 1);
		assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0, 'no cascade of savepoint rollbacks');
		assert.equal(sp.state, 'released', 'savepoint work kept by the commit');
		await assert.rejects(async () => { await sp.rollback(); }, TypeError);
	});

	test('rollback with open savepoints is one ROLLBACK (no cascade); marks spent', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.rollback();
		assert.equal(conn.rollback.mock.callCount(), 1);
		assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0, 'no cascade of savepoint rollbacks');
		assert.equal(sp.state, 'rolled-back');
	});

	test('disposing a savepoint after its transaction settled is a forgiving no-op', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		const sp = await tx.savepoint();
		await tx.commit();
		await sp[Symbol.asyncDispose]();  // must not throw or hit the wire
		assert.equal(conn.rollbackToSavepoint.mock.callCount(), 0);
	});
});

// ─── Concurrency safety — finalisation guard + serialised control ops ──────
//
// The pinned connection serves one request at a time; `fakeConnection`
// with `detectOverlap` rejects overlapping wire ops so an un-serialised
// regression throws rather than passing silently. commit/rollback hold one
// finalisation promise so repeat or racing settles are idempotent and
// disposal never turns a commit into a rollback.

// Drain the microtask queue (one macrotask boundary) — lets every settled
// promise that *can* progress do so, so "did NOT run" assertions are sound.
const drain = (): Promise<void> => new Promise<void>((res) => { setImmediate(res); });

describe('Transaction — concurrency safety', () => {
	test('parallel commit() calls issue exactly one COMMIT', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.commit(), tx.commit(), tx.commit()]);
		assert.equal(conn.commit.mock.callCount(), 1, 'only one COMMIT reached the wire');
		assert.equal(tx.state, 'committed');
	});

	test('parallel rollback() calls issue exactly one ROLLBACK', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.rollback(), tx.rollback()]);
		assert.equal(conn.rollback.mock.callCount(), 1);
		assert.equal(tx.state, 'rolled-back');
	});

	test('commit() + rollback() in parallel — first call wins, one wire op', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		await Promise.all([tx.commit(), tx.rollback()]);  // commit issued first
		assert.equal(conn.commit.mock.callCount(), 1, 'commit (issued first) wins');
		assert.equal(conn.rollback.mock.callCount(), 0, 'no rollback once a settle is in flight');
		assert.equal(tx.state, 'committed');
	});

	test('unawaited commit() + disposal does NOT roll back', async () => {
		const { sql, conn } = makePool();
		{
			await using tx = await sql.transaction();
			void tx.commit();  // not awaited — disposal must await it, not roll back
		}
		assert.equal(conn.commit.mock.callCount(), 1);
		assert.equal(conn.rollback.mock.callCount(), 0, 'disposal did not turn the commit into a rollback');
	});

	test('a query issued after an unawaited commit() is rejected (settling)', async () => {
		const { sql } = makePool();
		const tx = await sql.transaction();
		void tx.commit();  // settling — state still reads "open" until the wire lands
		assert.throws(() => tx`SELECT 1`, TypeError, 'no new work once a settle is in flight');
		await tx.commit();  // drain the in-flight commit
	});

	test('parallel savepoint() calls serialise into ordered, distinct marks', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		try {
			// No overlap thrown (the fake rejects overlapping wire ops): three
			// SAVEs land sequentially, in call order, with distinct names.
			const [a, b, c] = await Promise.all([
				tx.savepoint(),
				tx.savepoint(),
				tx.savepoint(),
			]);
			const savepointNames = conn.savepoint.mock.calls.map((call) => call.arguments[0]);
			assert.equal(savepointNames.length, 3);
			assert.equal(new Set([a.name, b.name, c.name]).size, 3, 'distinct marks');
			assert.deepEqual(savepointNames, [a.name, b.name, c.name]);
		} finally {
			await tx.rollback();
		}
	});

	test('commit() serialises behind an in-flight query (waits, no overlap)', async () => {
		const { sql, conn } = makePool();
		const tx = await sql.transaction();
		const release = conn.holdNextExecute();
		const query = tx`SELECT 1`.run();   // enters the connection, held in flight
		await drain();                      // let the query reach the wire
		const committed = tx.commit();
		await drain();                      // give commit every chance to (wrongly) fire
		assert.equal(conn.commit.mock.callCount(), 0, 'commit waits for the in-flight query');
		release();                          // let the query finish
		await query;
		await committed;
		assert.equal(conn.commit.mock.callCount(), 1, 'commit ran once the query settled');
		assert.equal(conn.execute.mock.callCount(), 1);
		assert.equal(tx.state, 'committed');
	});
});
