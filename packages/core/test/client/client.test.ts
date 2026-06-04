import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type Client,
	ClientClosedError,
	ClientNotConnectedError,
	ConnectionError,
	createClient,
	type ExecuteRequest,
} from '../../src/index.js';
import { type FakeConnection, baseConfig, fakeConnection, fakeDriver } from '../support/fakes.js';

// Resolve `true` if `p` is still pending after a flush of the microtask
// queue, `false` if it has settled. Deterministic — no timers. The pool's
// drain promise resolves via the slot-release microtask chain, never a
// timer, so flushing the microtask queue is enough to tell pending from
// settled. Used to assert `close()` stays pending while a connection is
// held without racing a wall-clock delay.
async function stillPending(p: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void p.then(() => { settled = true; }, () => { settled = true; });
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return !settled;
}

// ─── Construction ───────────────────────────────────────────────────────────

describe('Client — construction', () => {
	test('createClient is synchronous; no driver.open() until connect()', () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		assert.equal(client.state, 'pending');
		assert.equal(driver.open.mock.callCount(), 0, 'driver.open not called at construction');
	});

	test('exposes a `sql` tagged-template callable from construction', () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		assert.equal(typeof client.sql, 'function');
	});
});

// ─── connect() lifecycle ────────────────────────────────────────────────────

describe('Client.connect()', () => {
	test('opens a connection eagerly and transitions state pending → open', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		assert.equal(client.state, 'open');
		assert.equal(driver.open.mock.callCount(), 1, 'driver.open called once during connect()');
	});

	test('threads the credential + transport through to driver.open()', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		const opts = driver.open.mock.calls[0]?.arguments[0];
		assert.deepEqual(opts?.credential, baseConfig.credential);
		assert.deepEqual(opts?.transport, baseConfig.transport);
	});

	test('repeated connect() calls during a single in-flight attempt return the same Promise', () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		const p1 = client.connect();
		const p2 = client.connect();
		assert.equal(p1, p2);
	});

	test('connect() called when already open is a no-op', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.connect();
		assert.equal(client.state, 'open');
		assert.equal(driver.open.mock.callCount(), 1, 'no second open');
	});

	test('connect() failure transitions state to destroyed (terminal) and surfaces the error', async () => {
		const driver = fakeDriver({
			connectionFactory: () => { throw new ConnectionError('auth failed'); },
		});
		const client = createClient({ driver, ...baseConfig });
		await assert.rejects(() => client.connect(), ConnectionError);
		assert.equal(client.state, 'destroyed');
	});

	test('connect() against a destroyed client rejects with ClientClosedError', async () => {
		const driver = fakeDriver();
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
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await assert.rejects(
			async () => { await client.sql`SELECT 1`; },
			ClientNotConnectedError,
		);
	});

	test('queries after close() throw ClientClosedError', async () => {
		const driver = fakeDriver();
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
		const driver = fakeDriver();
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
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.close();
		assert.equal(client.state, 'destroyed');
	});

	test('repeated close() calls return the same Promise', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		const p1 = client.close();
		const p2 = client.close();
		assert.equal(p1, p2);
		await p1;
	});

	test('close() on a never-connected client just transitions to destroyed', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.close();
		assert.equal(client.state, 'destroyed');
		assert.equal(driver.open.mock.callCount(), 0, 'driver.open never called');
	});

	test('close() on a destroyed client is idempotent (resolved Promise, no error)', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.destroy();
		await client.close();
		assert.equal(client.state, 'destroyed');
	});
});

// ─── destroy() lifecycle ────────────────────────────────────────────────────

describe('Client.destroy()', () => {
	test('force-closes the pool and transitions state to destroyed', async () => {
		let conn: FakeConnection | undefined;
		const driver = fakeDriver({ connectionFactory: () => (conn = fakeConnection()) });
		const client = createClient({ driver, ...baseConfig });
		await client.connect();
		await client.destroy();
		assert.equal(client.state, 'destroyed');
		assert.equal(conn?.close.mock.callCount(), 1, 'underlying connection closed');
	});

	test('repeated destroy() calls return the same Promise', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		const p1 = client.destroy();
		const p2 = client.destroy();
		assert.equal(p1, p2);
	});

	test('destroy() concurrent with close() short-circuits the drain', async () => {
		const driver = fakeDriver();
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

// ─── close() / destroy() with a held ReservedConn (sql.acquire interaction) ──
//
// `sql.acquire()` (R-5) pins the pool's connection for the lifetime of a
// `ReservedConn`. `client.close()` is a graceful drain (`pool.drain()`),
// so it must NOT resolve while a holder still owns the connection — it
// waits for `ReservedConn.release()`. `client.destroy()` is the force-
// close escape hatch and does NOT wait. New acquires during the drain
// window reject. These compose the Client's real `SingleConnectionPool`
// (not a fake) so the drain-waits-for-release semantics are exercised
// end-to-end.

describe('Client — close() / destroy() with a held ReservedConn', () => {
	test('close() stays pending while a ReservedConn is held, and resolves once it is released', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const conn = await client.sql.acquire();

		// Graceful close begins draining but must not complete while the
		// ReservedConn owns the connection.
		const closePromise = client.close();
		assert.equal(client.state, 'draining', 'close() entered draining');
		assert.equal(
			await stillPending(closePromise),
			true,
			'close() pending while ReservedConn held',
		);

		// Release the holder — drain now completes and close() resolves.
		await conn.release();
		await closePromise;
		assert.equal(client.state, 'destroyed');
	});

	test('destroy() force-closes even while a ReservedConn is held (does not wait)', async () => {
		let conn: FakeConnection | undefined;
		const driver = fakeDriver({ connectionFactory: () => (conn = fakeConnection()) });
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const reserved = await client.sql.acquire();

		// Force-close resolves WITHOUT waiting for release.
		await client.destroy();
		assert.equal(client.state, 'destroyed');
		assert.equal(conn?.close.mock.callCount(), 1, 'held connection was force-closed');

		// Releasing the (now-defunct) ReservedConn afterwards is a safe
		// no-op — the pool is destroyed, so release short-circuits.
		await reserved.release();
		assert.equal(conn?.close.mock.callCount(), 1, 'no double close on late release');
	});

	test('sql.acquire() while draining rejects with ClientClosedError', async () => {
		const driver = fakeDriver();
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		// Hold one ReservedConn so close() parks in draining.
		const held = await client.sql.acquire();
		const closePromise = client.close();
		assert.equal(client.state, 'draining');

		// A new acquire during the drain window rejects fast.
		await assert.rejects(
			async () => { await client.sql.acquire(); },
			(err: unknown) => {
				assert.ok(err instanceof ClientClosedError);
				assert.equal(err.state, 'draining');
				return true;
			},
		);

		// Cleanup — release lets the drain finish.
		await held.release();
		await closePromise;
	});

	test('a held ReservedConn keeps running queries while the client is draining', async () => {
		const driver = fakeDriver({
			connectionFactory: () => fakeConnection({
				execute: () => [
					{ kind: 'metadata', columns: [{ name: 'n' }] },
					{ kind: 'row', values: [1] },
					{ kind: 'rowsetEnd', rowsAffected: 1 },
					{ kind: 'done' },
				],
			}),
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const conn = await client.sql.acquire();
		const closePromise = client.close();
		assert.equal(client.state, 'draining');

		// The held connection runs its query directly (pinned runner, not
		// gated by the Client state) — graceful drain lets in-flight
		// holders finish their work.
		const rows = await conn<{ n: number }>`SELECT 1 AS n`;
		assert.deepEqual(rows, [{ n: 1 }]);

		// Still pending until the holder releases.
		assert.equal(await stillPending(closePromise), true);
		await conn.release();
		await closePromise;
		assert.equal(client.state, 'destroyed');
	});
});

// ─── End-to-end: sql tag → Query → poolRunner → SingleConnectionPool → FakeDriver ───

describe('Client — end-to-end smoke', () => {
	test('await client.sql`SELECT 1` returns rows from the FakeDriver', async () => {
		const driver = fakeDriver({
			connectionFactory: () => fakeConnection({
				execute: () => [
					{ kind: 'metadata', columns: [{ name: 'n' }] },
					{ kind: 'row', values: [1] },
					{ kind: 'rowsetEnd', rowsAffected: 1 },
					{ kind: 'done' },
				],
			}),
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		const rows = await client.sql<{ n: number }>`SELECT 1 AS n`;
		assert.deepEqual(rows, [{ n: 1 }]);

		await client.close();
	});

	test('parameter binding round-trips through the runner', async () => {
		let captured: ExecuteRequest | null = null;
		const driver = fakeDriver({
			connectionFactory: () => fakeConnection({
				execute: (req) => {
					captured = req;
					return [
						{ kind: 'metadata', columns: [{ name: 'x' }] },
						{ kind: 'row', values: [req.params?.[0]?.value] },
						{ kind: 'rowsetEnd', rowsAffected: 1 },
						{ kind: 'done' },
					];
				},
			}),
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
		let conn: FakeConnection | undefined;
		const driver = fakeDriver({
			connectionFactory: () => (conn = fakeConnection({
				execute: () => [
					{ kind: 'metadata', columns: [{ name: 'n' }] },
					{ kind: 'row', values: [1] },
					{ kind: 'rowsetEnd', rowsAffected: 1 },
					{ kind: 'done' },
				],
			})),
		});
		const client = createClient({ driver, ...baseConfig });
		await client.connect();

		await client.sql`SELECT 1`;
		await client.sql`SELECT 1`;
		await client.sql`SELECT 1`;

		assert.equal(driver.open.mock.callCount(), 1, 'driver.open called only once');
		assert.equal(conn?.execute.mock.callCount(), 3, '3 executes on same connection');
		// reset() runs on every release. Each query is one acquire+release;
		// `client.connect()`'s eager-validate is a fourth (acquire-and-immediately-release).
		assert.equal(conn?.reset.mock.callCount(), 4, 'reset called per release (connect + 3 queries)');

		await client.close();
	});
});

// ─── Ergonomics: connect()→this, await using, non-thenable (#4) ─────────────

describe('Client — ergonomics', () => {
	test('connect() resolves to the client (chainable)', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		const returned = await client.connect();
		assert.equal(returned, client);
		await client.close();
	});

	test('await createClient(...).connect() yields a connected client', async () => {
		const client = await createClient({ driver: fakeDriver(), ...baseConfig }).connect();
		assert.equal(client.state, 'open');
		await client.close();
	});

	test('await using disposes the client (destroy) at scope exit', async () => {
		let captured: Client | undefined;
		{
			await using client = await createClient({ driver: fakeDriver(), ...baseConfig }).connect();
			captured = client;
			assert.equal(client.state, 'open');
		}
		assert.ok(captured);
		assert.equal(captured.state, 'destroyed');
	});

	test('await using force-closes via destroy() even with a held connection (no hang)', async () => {
		let conn: FakeConnection | undefined;
		let captured: Client | undefined;
		const driver = fakeDriver({ connectionFactory: () => (conn = fakeConnection()) });
		{
			await using client = await createClient({ driver, ...baseConfig }).connect();
			captured = client;
			// Acquire a ReservedConn and never release it. A graceful close()
			// would block forever here; destroy()-on-dispose must not.
			await client.sql.acquire();
		}
		assert.ok(captured);
		assert.equal(captured.state, 'destroyed');
		assert.ok(conn);
		assert.equal(conn.close.mock.callCount(), 1, 'held connection force-closed on dispose');
	});
});
