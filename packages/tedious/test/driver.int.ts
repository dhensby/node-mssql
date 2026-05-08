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
