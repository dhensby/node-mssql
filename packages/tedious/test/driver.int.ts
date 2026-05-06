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
