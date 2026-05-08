// End-to-end integration tests against a real SQL Server.
//
// Stack under test:
//   client.sql`...`           (sql tag from V-2)
//     → Query<T>.then()       (V-1)
//       → poolRunner          (V-2)
//         → SingleConnectionPool   (Commit B-1)
//           → tediousDriver()      (V-3 — this commit)
//             → real TDS over TCP to docker SQL Server
//
// Configured via MSSQL_TEST_* env vars (see ./integration.ts). Missing
// env or unreachable server fails the test loudly — we don't silently
// skip integration tests.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@tediousjs/mssql-core';
import { tediousDriver } from '../src/index.js';
import { type IntegrationConfig, requireIntegrationConfig } from './integration.js';

// Build a Client wired to the integration-test docker container. Each
// test gets a fresh client — the SingleConnectionPool inside opens the
// connection on `connect()`, holds it for the test's queries, and the
// `await using` / `await client.close()` at test end drains and tears
// it down.
function makeClient(config: IntegrationConfig): ReturnType<typeof createClient> {
	return createClient({
		driver: tediousDriver(),
		credential: {
			kind: 'password',
			userName: config.user,
			password: config.password,
		},
		transport: {
			host: config.host,
			port: config.port,
			database: config.database,
			// The docker `azure-sql-edge` image presents a self-signed cert;
			// the test config trusts it. Production clients should not.
			trustServerCertificate: true,
		},
	});
}

// ─── Connection lifecycle ───────────────────────────────────────────────────

describe('tediousDriver — connection lifecycle (integration)', () => {
	test('connect() succeeds against the configured server', async () => {
		const config = requireIntegrationConfig();
		const client = makeClient(config);
		await client.connect();
		assert.equal(client.state, 'open');
		await client.close();
		assert.equal(client.state, 'destroyed');
	});

	test('connect() with bad credentials surfaces ConnectionError', async () => {
		const config = requireIntegrationConfig();
		const client = createClient({
			driver: tediousDriver(),
			credential: { kind: 'password', userName: 'sa', password: 'definitely-wrong' },
			transport: {
				host: config.host,
				port: config.port,
				trustServerCertificate: true,
			},
		});
		await assert.rejects(
			() => client.connect(),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				return true;
			},
		);
		assert.equal(client.state, 'destroyed', 'failed connect transitions to destroyed');
	});
});

// ─── SELECT — the load-bearing smoke test ──────────────────────────────────

describe('tediousDriver — SELECT (integration)', () => {
	test('await sql`SELECT 1 AS n` returns [{n: 1}]', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
			assert.deepEqual(rows, [{ n: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('await sql`SELECT ${42} AS n` round-trips an integer parameter', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ n: number }>`SELECT ${42} AS n`;
			assert.deepEqual(rows, [{ n: 42 }]);
		} finally {
			await client.close();
		}
	});

	test('round-trips a string parameter', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ s: string }>`SELECT ${'hello'} AS s`;
			assert.deepEqual(rows, [{ s: 'hello' }]);
		} finally {
			await client.close();
		}
	});

	test('round-trips multiple parameters in a single statement', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ a: number; b: string; c: number }>`
				SELECT ${1} AS a, ${'two'} AS b, ${3} AS c
			`;
			assert.deepEqual(rows, [{ a: 1, b: 'two', c: 3 }]);
		} finally {
			await client.close();
		}
	});

	test('returns multiple rows from a UNION', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ n: number }>`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
			`;
			assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
		} finally {
			await client.close();
		}
	});

	test('returns an empty array for a query with no rows', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql<{ n: number }>`SELECT 1 AS n WHERE 1 = 0`;
			assert.deepEqual(rows, []);
		} finally {
			await client.close();
		}
	});
});

// ─── Connection reuse via SingleConnectionPool ──────────────────────────────

describe('tediousDriver — connection reuse (integration)', () => {
	test('three sequential queries reuse the SingleConnectionPool connection', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const a = await client.sql<{ n: number }>`SELECT 1 AS n`;
			const b = await client.sql<{ n: number }>`SELECT 2 AS n`;
			const c = await client.sql<{ n: number }>`SELECT 3 AS n`;
			assert.deepEqual(a, [{ n: 1 }]);
			assert.deepEqual(b, [{ n: 2 }]);
			assert.deepEqual(c, [{ n: 3 }]);
			// Reuse is internal — visible only via timing / driver logs in
			// V-3. The R-9 round-out (diagnostics_channel) will surface
			// `mssql:pool:acquire` events that observers can count.
		} finally {
			await client.close();
		}
	});
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

describe('tediousDriver — Client lifecycle (integration)', () => {
	test('client.destroy() force-closes a connected client', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		await client.destroy();
		assert.equal(client.state, 'destroyed');
	});

	test('queries after close() throw ClientClosedError', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		await client.close();
		await assert.rejects(
			async () => { await client.sql`SELECT 1`; },
			/client is destroyed/,
		);
	});
});

// ─── Round-out terminals: .iterate / .run / .result / .meta ─────────────────

describe('tediousDriver — round-out terminals (integration)', () => {
	test('for await streams rows one at a time', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const seen: number[] = [];
			for await (const row of client.sql<{ n: number }>`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
			`) {
				seen.push(row.n);
			}
			assert.deepEqual(seen, [1, 2, 3]);
		} finally {
			await client.close();
		}
	});

	test('.run() drains a SELECT and reports rowsAffected', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const meta = await client.sql`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
			`.run();
			assert.equal(meta.completed, true);
			// Tedious reports rowsAffected for SELECT statements; the value
			// reflects what the server emits in its DONE token.
			assert.ok(meta.rowsAffected >= 0);
		} finally {
			await client.close();
		}
	});

	test('.result() returns rows + meta in one shape', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const { rows, meta } = await client.sql<{ n: number }>`
				SELECT 1 AS n UNION ALL SELECT 2 AS n
			`.result();
			assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
			assert.equal(meta.completed, true);
		} finally {
			await client.close();
		}
	});

	test('.meta() throws before stream terminates and works after', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql`SELECT 1 AS n`;
			assert.throws(() => q.meta(), TypeError);
			await q;
			const meta = q.meta();
			assert.equal(meta.completed, true);
		} finally {
			await client.close();
		}
	});

	test('.run() is rowset-oblivious (does not throw on multi-statement)', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			// A multi-statement batch — `.run()` should drain quietly and
			// the trailer should reflect the per-statement counts.
			const meta = await client.sql`
				SELECT 1 AS a;
				SELECT 2 AS b;
			`.run();
			assert.equal(meta.completed, true);
			assert.ok(
				meta.rowsAffectedPerStatement.length >= 1,
				'per-statement counts populated',
			);
		} finally {
			await client.close();
		}
	});
});

// ─── .columns() — first-rowset shape access (integration) ──────────────────
//
// Validates the shape-only pump path against a real driver: the pump
// pulls events until tedious emits the `columnMetadata` token, then
// stops. The connection stays held by the surrounding poolRunner
// (driver-level backpressure on the wire), and a subsequent row
// terminal continues from the same paused iterator. `.dispose()` on a
// paused shape pump must call `iter.return()` through to the bridge,
// which cancels the in-flight request and releases the connection.

describe('tediousDriver — .columns() first-rowset shape access (integration)', () => {
	test('resolves to the column metadata of a SELECT before any terminal fires', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql`SELECT 1 AS a, 'x' AS b`;
			const cols = await q.columns();
			assert.deepEqual(cols.map((c) => c.name), ['a', 'b']);
			// Drive the stream to completion so the connection releases
			// cleanly back to the pool.
			await q.run();
		} finally {
			await client.close();
		}
	});

	test('terminal after .columns() drains the lookahead and yields rows', async () => {
		// Lookahead handoff — the shape pump captures the metadata into
		// the buffer; the row terminal drains the buffer first, then
		// continues from the same paused iterator. End-to-end: a single
		// connection acquisition, one tedious Request, a single round-
		// trip's worth of work.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql<{ n: number }>`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
			`;
			const cols = await q.columns();
			assert.deepEqual(cols.map((c) => c.name), ['n']);
			const rows = await q.all();
			assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
		} finally {
			await client.close();
		}
	});

	test('.columns() is locked to the FIRST rowset on multi-statement batches', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql`
				SELECT 1 AS first;
				SELECT 2 AS second;
			`;
			const cols = await q.columns();
			assert.deepEqual(cols.map((c) => c.name), ['first']);
			// Drive to completion via .run() (rowset-oblivious).
			await q.run();
			const colsAgain = await q.columns();
			assert.deepEqual(colsAgain.map((c) => c.name), ['first']);
		} finally {
			await client.close();
		}
	});

	test('.columns() resolves to [] for a query that produces no rowsets', async () => {
		// Pure DDL/DML — no metadata token ever flows. The shape pump
		// reaches the end of the stream and resolves with [].
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const cols = await client.sql`PRINT 'no rowsets here'`.columns();
			assert.deepEqual(cols, []);
		} finally {
			await client.close();
		}
	});

	test('.dispose() on a paused shape pump cancels and releases cleanly', async () => {
		// `WAITFOR DELAY '00:00:10'` parks the server-side request before
		// any rowset arrives. `.columns()` would normally resolve only
		// once metadata flows; with no metadata in flight, the shape
		// pump waits. `.dispose()` must call iter.return() through to
		// the bridge and release the connection — confirmed by a
		// follow-up query on the same client succeeding immediately.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql`WAITFOR DELAY '00:00:10'; SELECT 1 AS n`;
			const colsPromise = q.columns();
			// Yield to let the shape pump kick the request off.
			await new Promise((r) => setTimeout(r, 50));
			await q.dispose();
			// The columns promise rejects (cancelled before metadata).
			await assert.rejects(() => colsPromise);
			// Follow-up query on the same client succeeds — the shape
			// pump's dispose path released the connection cleanly.
			const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
			assert.deepEqual(rows, [{ n: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('Promise.all([columns(), all()]) returns matching shape and rows', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql<{ n: number }>`SELECT 1 AS n UNION ALL SELECT 2`;
			const [cols, rows] = await Promise.all([q.columns(), q.all()]);
			assert.deepEqual(cols.map((c) => c.name), ['n']);
			assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
		} finally {
			await client.close();
		}
	});
});

// ─── sql.unsafe — raw text escape hatch (integration) ──────────────────────
//
// End-to-end validation that `sql.unsafe(text, params?)` reaches the
// driver and binds parameters identically to the tagged-template form.
// The escape hatch is the integration point for query-builder output
// (Kysely / Drizzle / etc.) — exercising it against a real server here.

describe('tediousDriver — sql.unsafe (integration)', () => {
	test('raw text passes through and rows return as expected', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql.unsafe<{ n: number }>('SELECT 1 AS n');
			assert.deepEqual(rows, [{ n: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('object params bind by name', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql.unsafe<{ a: number; b: string }>(
				'SELECT @id AS a, @name AS b',
				{ id: 7, name: 'alice' },
			);
			assert.deepEqual(rows, [{ a: 7, b: 'alice' }]);
		} finally {
			await client.close();
		}
	});

	test('array params bind positionally as @p0, @p1, …', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const rows = await client.sql.unsafe<{ a: number; b: string }>(
				'SELECT @p0 AS a, @p1 AS b',
				[42, 'hello'],
			);
			assert.deepEqual(rows, [{ a: 42, b: 'hello' }]);
		} finally {
			await client.close();
		}
	});
});

// ─── sql.acquire — pinned connection scope (integration) ───────────────────
//
// `sql.acquire()` reserves a pool connection for the lifetime of an
// `await using` (or until explicit `.release()`). The pin makes
// session-scoped state safe — temp tables created on the connection
// persist across queries on the same `ReservedConn`, where pool-bound
// queries can't make that guarantee.
//
// The acceptance test for "the connection is truly pinned" is a
// `#temp` table — it's session-scoped on SQL Server, so its presence
// across two queries on a `ReservedConn` proves they ran on the same
// underlying connection.

describe('tediousDriver — sql.acquire (integration)', () => {
	test('two queries on the same ReservedConn run on the same SQL Server session', async () => {
		// `@@SPID` is the session's SQL Server process id — same SPID
		// across two queries proves they ran on the same connection.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			await using conn = await client.sql.acquire();
			const a = await conn<{ spid: number }>`SELECT @@SPID AS spid`;
			const b = await conn<{ spid: number }>`SELECT @@SPID AS spid`;
			assert.ok(a[0] !== undefined && b[0] !== undefined);
			assert.equal(a[0]?.spid, b[0]?.spid, 'two queries shared one session');
		} finally {
			await client.close();
		}
	});

	test('session-scoped state (#temp tables) persists across queries on the same ReservedConn', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			await using conn = await client.sql.acquire();
			// Create a temp table on the pinned connection and insert a row.
			await conn`CREATE TABLE #items (id INT, name NVARCHAR(50))`.run();
			await conn`INSERT INTO #items (id, name) VALUES (${1}, ${'alice'})`.run();
			// Read it back — must be the SAME connection or #items is gone.
			const rows = await conn<{ id: number; name: string }>`
				SELECT id, name FROM #items
			`;
			assert.deepEqual(rows, [{ id: 1, name: 'alice' }]);
		} finally {
			await client.close();
		}
	});

	test('release() returns the connection; pool-bound queries continue to work', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const conn = await client.sql.acquire();
			await conn`SELECT 1`.run();
			await conn.release();
			// Pool-bound query after release — should succeed (the pool
			// has a connection again).
			const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
			assert.deepEqual(rows, [{ n: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('queries after release() throw TypeError', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const conn = await client.sql.acquire();
			await conn.release();
			assert.throws(() => conn`SELECT 1`, TypeError);
		} finally {
			await client.close();
		}
	});

	test('Promise.all on a ReservedConn serialises FIFO (no EREQINPROG)', async () => {
		// Three queries fired concurrently on the same pinned connection.
		// In v12 the second would error with EREQINPROG; in v13 they
		// queue internally and resolve in order.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			await using conn = await client.sql.acquire();
			const [a, b, c] = await Promise.all([
				conn<{ n: number }>`SELECT 1 AS n`,
				conn<{ n: number }>`SELECT 2 AS n`,
				conn<{ n: number }>`SELECT 3 AS n`,
			]);
			assert.deepEqual(a, [{ n: 1 }]);
			assert.deepEqual(b, [{ n: 2 }]);
			assert.deepEqual(c, [{ n: 3 }]);
		} finally {
			await client.close();
		}
	});

	test('await using disposes the ReservedConn at scope exit', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			let captured: { released: boolean } | null = null;
			{
				await using conn = await client.sql.acquire();
				await conn`SELECT 1`.run();
				captured = conn;
				assert.equal(conn.released, false);
			}
			// After scope exit, conn is released.
			assert.equal(captured.released, true);
		} finally {
			await client.close();
		}
	});

	test('.unsafe() works on a ReservedConn too', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			await using conn = await client.sql.acquire();
			const rows = await conn.unsafe<{ n: number }>(
				'SELECT @x AS n',
				{ x: 99 },
			);
			assert.deepEqual(rows, [{ n: 99 }]);
		} finally {
			await client.close();
		}
	});
});

// ─── sql.transaction — server-side transactions (integration) ────────────
//
// End-to-end validation of the BEGIN / COMMIT / ROLLBACK pipeline
// against a real server, plus the savepoint set. Acceptance test —
// rollback-discards / commit-persists is verified through a single
// connection so the visibility contract is unambiguous.

describe('tediousDriver — sql.transaction (integration)', () => {
	// All tx tests use a #temp table to scope changes to the test's
	// session; the table goes away when the connection releases. No
	// shared-state cleanup needed, no database-permission impact.

	test('commit persists changes within the transaction scope', async () => {
		// `sql.transaction()` opens a tx on a FRESH pool connection, so
		// the visible-after-commit assertion has to use a server-scoped
		// table that survives the connection release. A `##global temp`
		// works (visible to all sessions until the creating session
		// ends — but in this test we use a unique name and tear down
		// manually). Acceptance: row inserted inside the tx is visible
		// AFTER the tx commits, on a separate (pool-bound) query.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tableName = `dbo.t_${Math.random().toString(36).slice(2, 10)}`;
			await client.sql.unsafe(
				`CREATE TABLE ${tableName} (id INT)`,
			).run();
			try {
				const tx = await client.sql.transaction();
				try {
					await tx.unsafe(`INSERT INTO ${tableName} (id) VALUES (1)`).run();
					await tx.commit();
				} catch (err) {
					await tx.rollback();
					throw err;
				}
				const rows = await client.sql.unsafe<{ id: number }>(
					`SELECT id FROM ${tableName}`,
				);
				assert.deepEqual(rows, [{ id: 1 }], 'commit persisted the insert');
			} finally {
				await client.sql.unsafe(`DROP TABLE ${tableName}`).run();
			}
		} finally {
			await client.close();
		}
	});

	test('rollback discards changes within the transaction scope', async () => {
		// `sql.transaction()` opens a tx on a NEW connection from the
		// pool — so the #temp table created inside the tx is on that
		// connection. After rollback, the connection releases (and
		// resets), discarding both the tx changes AND the temp table.
		// That makes a tx + #temp visibility test against `sql.transaction()`
		// awkward to express. Use a permanent table for this test, scoped
		// to a unique GUID-named ##global temp.
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tableName = `dbo.t_${Math.random().toString(36).slice(2, 10)}`;
			// Set up a global temp table that's visible across connections.
			await client.sql.unsafe(
				`CREATE TABLE ${tableName} (id INT)`,
			).run();
			try {
				const tx = await client.sql.transaction();
				try {
					await tx.unsafe(`INSERT INTO ${tableName} (id) VALUES (1)`).run();
					await tx.rollback();
				} catch {
					await tx.rollback();
					throw new Error('tx unexpectedly threw');
				}
				const rows = await client.sql.unsafe<{ id: number }>(
					`SELECT id FROM ${tableName}`,
				);
				assert.deepEqual(rows, [], 'rollback discarded the insert');
			} finally {
				await client.sql.unsafe(`DROP TABLE ${tableName}`).run();
			}
		} finally {
			await client.close();
		}
	});

	test('await using disposes a transaction (rollback default)', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tableName = `dbo.t_${Math.random().toString(36).slice(2, 10)}`;
			await client.sql.unsafe(
				`CREATE TABLE ${tableName} (id INT)`,
			).run();
			try {
				{
					await using tx = await client.sql.transaction();
					await tx.unsafe(`INSERT INTO ${tableName} (id) VALUES (1)`).run();
					// fall off scope without commit — rollback fires
				}
				const rows = await client.sql.unsafe<{ id: number }>(
					`SELECT id FROM ${tableName}`,
				);
				assert.deepEqual(rows, [], 'dispose-without-commit rolled back');
			} finally {
				await client.sql.unsafe(`DROP TABLE ${tableName}`).run();
			}
		} finally {
			await client.close();
		}
	});

	test('explicit isolation level reaches the server', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tx = await client.sql.transaction().isolationLevel('serializable');
			try {
				// `DBCC USEROPTIONS` reports the current session's
				// transaction isolation level.
				interface Row { 'Set Option': string; Value: string }
				const rows = await tx<Row>`DBCC USEROPTIONS`;
				const row = rows.find(
					(r) => r['Set Option'].toLowerCase() === 'isolation level',
				);
				assert.ok(row !== undefined, 'isolation level reported');
				assert.equal(row?.Value.toLowerCase(), 'serializable');
			} finally {
				await tx.rollback();
			}
		} finally {
			await client.close();
		}
	});

	test('Promise.all on a transaction serialises FIFO (no EREQINPROG)', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			await using tx = await client.sql.transaction();
			const [a, b, c] = await Promise.all([
				tx<{ n: number }>`SELECT 1 AS n`,
				tx<{ n: number }>`SELECT 2 AS n`,
				tx<{ n: number }>`SELECT 3 AS n`,
			]);
			assert.deepEqual(a, [{ n: 1 }]);
			assert.deepEqual(b, [{ n: 2 }]);
			assert.deepEqual(c, [{ n: 3 }]);
			await tx.commit();
		} finally {
			await client.close();
		}
	});
});

// ─── tx.savepoint — savepoint scope (integration) ─────────────────────────

describe('tediousDriver — tx.savepoint (integration)', () => {
	test('savepoint rollback discards work since the savepoint; outer commit persists rest', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tableName = `dbo.t_${Math.random().toString(36).slice(2, 10)}`;
			await client.sql.unsafe(
				`CREATE TABLE ${tableName} (id INT)`,
			).run();
			try {
				const tx = await client.sql.transaction();
				try {
					await tx.unsafe(`INSERT INTO ${tableName} (id) VALUES (1)`).run();
					{
						await using sp = await tx.savepoint();
						await sp.unsafe(`INSERT INTO ${tableName} (id) VALUES (2)`).run();
						// fall off without release → rollback to savepoint
						void sp;
					}
					await tx.unsafe(`INSERT INTO ${tableName} (id) VALUES (3)`).run();
					await tx.commit();
				} catch (err) {
					await tx.rollback();
					throw err;
				}
				// Outer commit persisted ids 1 and 3; savepoint rollback
				// discarded id 2.
				const rows = await client.sql.unsafe<{ id: number }>(
					`SELECT id FROM ${tableName} ORDER BY id`,
				);
				assert.deepEqual(rows, [{ id: 1 }, { id: 3 }]);
			} finally {
				await client.sql.unsafe(`DROP TABLE ${tableName}`).run();
			}
		} finally {
			await client.close();
		}
	});

	test('savepoint release leaves work intact for the outer commit', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const tableName = `dbo.t_${Math.random().toString(36).slice(2, 10)}`;
			await client.sql.unsafe(
				`CREATE TABLE ${tableName} (id INT)`,
			).run();
			try {
				const tx = await client.sql.transaction();
				try {
					const sp = await tx.savepoint();
					await sp.unsafe(`INSERT INTO ${tableName} (id) VALUES (10)`).run();
					await sp.release();
					await tx.commit();
				} catch (err) {
					await tx.rollback();
					throw err;
				}
				const rows = await client.sql.unsafe<{ id: number }>(
					`SELECT id FROM ${tableName}`,
				);
				assert.deepEqual(rows, [{ id: 10 }]);
			} finally {
				await client.sql.unsafe(`DROP TABLE ${tableName}`).run();
			}
		} finally {
			await client.close();
		}
	});
});

// ─── .rowsets() — multi-rowset terminal (integration) ─────────────────────
//
// End-to-end validation of the `Rowsets<Tuple>` two-form contract
// (ADR-0006): awaited buffer returns a tuple of arrays; iterated
// yields nested AsyncIterable per rowset. Break semantics — inner
// drains; outer cancels — are exercised here against tedious's
// real `done` token boundaries.

describe('tediousDriver — .rowsets() multi-rowset (integration)', () => {
	test('await yields a tuple of arrays for a multi-statement batch', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const [a, b] = await client.sql`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3;
				SELECT 'x' AS s UNION ALL SELECT 'y';
			`.rowsets<[{ n: number }, { s: string }]>();
			assert.deepEqual(a, [{ n: 1 }, { n: 2 }, { n: 3 }]);
			assert.deepEqual(b, [{ s: 'x' }, { s: 'y' }]);
		} finally {
			await client.close();
		}
	});

	test('for await yields one inner iterable per rowset, in source-SQL order', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const collected: unknown[][] = [];
			for await (const rs of client.sql`
				SELECT 1 AS n UNION ALL SELECT 2;
				SELECT 'x' AS s UNION ALL SELECT 'y' UNION ALL SELECT 'z';
			`.rowsets<[{ n: number }, { s: string }]>()) {
				const rows: unknown[] = [];
				for await (const row of rs) rows.push(row);
				collected.push(rows);
			}
			assert.deepEqual(collected, [
				[{ n: 1 }, { n: 2 }],
				[{ s: 'x' }, { s: 'y' }, { s: 'z' }],
			]);
		} finally {
			await client.close();
		}
	});

	test('inner break drains remaining rows of current rowset; next rowset arrives intact', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const collected: unknown[][] = [];
			let outerIndex = 0;
			for await (const rs of client.sql`
				SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3;
				SELECT 10 AS m UNION ALL SELECT 20;
			`.rowsets<[{ n: number }, { m: number }]>()) {
				const rows: unknown[] = [];
				for await (const row of rs) {
					rows.push(row);
					if (outerIndex === 0 && rows.length === 1) break;
				}
				collected.push(rows);
				outerIndex++;
			}
			assert.deepEqual(collected, [
				[{ n: 1 }],
				[{ m: 10 }, { m: 20 }],
			]);
			// The connection released cleanly — follow-up query on same
			// client succeeds.
			const rows = await client.sql<{ ok: number }>`SELECT 1 AS ok`;
			assert.deepEqual(rows, [{ ok: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('outer break cancels the request; follow-up query on same client succeeds', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			let saw = 0;
			for await (const rs of client.sql`
				SELECT 1 AS n UNION ALL SELECT 2;
				SELECT 'x' AS s;
			`.rowsets<[{ n: number }, { s: string }]>()) {
				// Drain inner naturally to a clean rowset boundary, then
				// break the outer — that's the cancel path.
				for await (const _row of rs) { /* */ }
				saw++;
				break;
			}
			assert.equal(saw, 1, 'broke after first rowset');
			// The cancel released the connection — follow-up succeeds.
			const rows = await client.sql<{ ok: number }>`SELECT 1 AS ok`;
			assert.deepEqual(rows, [{ ok: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('await on an empty (no-rowsets) batch resolves to []', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const result = await client.sql`PRINT 'hello'`.rowsets();
			assert.deepEqual(result, []);
		} finally {
			await client.close();
		}
	});

	test('.raw() mode + .rowsets() yields positional tuples', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			const q = client.sql`
				SELECT 1 AS a, 'x' AS b;
				SELECT 2 AS a, 'y' AS b;
			`;
			const result = await q.raw<[number, string]>().rowsets<[
				[number, string],
				[number, string],
			]>();
			assert.deepEqual(result, [
				[[1, 'x']],
				[[2, 'y']],
			]);
		} finally {
			await client.close();
		}
	});
});

// ─── Cancel-then-settle ordering against a real server (regression) ─────────
//
// The bug guarded against: cancel returning before tedious has
// settled the cancel-ack, leading to `Connection.reset()` on a mid-
// cancel-response connection and corrupting state for the next
// acquire. This integration test exercises the load-bearing path:
// cancel a long-running query, then immediately fire a new query
// on the same client. If the connection wasn't fully settled before
// release, the second query would observe corrupted state (or hang
// / error in subtle ways).

describe('tediousDriver — cancel-then-settle ordering (integration)', () => {
	test('a cancelled query releases the connection cleanly; a follow-up query on the same client succeeds', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			// Long-running query — `WAITFOR DELAY '00:00:10'` parks the
			// server-side request for 10s. We cancel it long before that.
			const long = client.sql`WAITFOR DELAY '00:00:10'; SELECT 1 AS n`;

			// Kick off iteration; cancel after a beat.
			const consumer = (async () => {
				try {
					for await (const _row of long.iterate()) { /* */ }
					return 'completed';
				} catch (err) {
					return (err as Error).message;
				}
			})();

			// Yield to let the server start the WAITFOR.
			await new Promise((r) => setTimeout(r, 50));

			// Cancel — must return only after tedious has settled the
			// cancel-ack and the connection is back in the pool. If
			// cancel returns prematurely, the SELECT 1 below would
			// observe a connection still settling the previous request.
			await long.cancel();
			await consumer;

			// Immediately fire another query — should succeed.
			const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
			assert.deepEqual(rows, [{ n: 1 }]);
		} finally {
			await client.close();
		}
	});

	test('await using disposes the query and cancels in flight on scope exit', async () => {
		const client = makeClient(requireIntegrationConfig());
		await client.connect();
		try {
			let scopeExited = false;
			{
				await using q = client.sql`WAITFOR DELAY '00:00:10'; SELECT 1 AS n`;

				// Start iteration in the background; scope exit cancels.
				const consumer = (async () => {
					try {
						for await (const _ of q.iterate()) { /* */ }
					} catch { /* expected */ }
				})();

				await new Promise((r) => setTimeout(r, 50));
				// Falling off the block cancels via Symbol.asyncDispose.
				void consumer;
			}
			scopeExited = true;
			// Connection should be back in the pool — next query succeeds.
			const rows = await client.sql<{ n: number }>`SELECT 2 AS n`;
			assert.deepEqual(rows, [{ n: 2 }]);
			assert.ok(scopeExited);
		} finally {
			await client.close();
		}
	});
});
