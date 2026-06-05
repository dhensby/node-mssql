import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type ExecuteRequest,
	poolRunner,
	type ResultEvent,
} from '../../src/index.js';
import { fakeConnection, fakePool } from '../support/fakes.js';

// ─── poolRunner — basic acquire / execute / release flow ────────────────────

describe('poolRunner — acquire / execute / release', () => {
	test('acquires the pool, runs execute, releases on natural drain', async () => {
		const conn = fakeConnection({ execute: [{ kind: 'done' }] });
		const { pool, release } = fakePool(conn);
		const runner = poolRunner(pool);

		const events: ResultEvent[] = [];
		for await (const ev of runner.run({ sql: 'SELECT 1' })) {
			events.push(ev);
		}

		assert.equal(pool.acquire.mock.callCount(), 1);
		assert.equal(release.mock.callCount(), 1, 'release should fire on natural drain');
		assert.equal(conn.execute.mock.callCount(), 1);
		assert.deepEqual(events, [{ kind: 'done' }]);
	});

	test('forwards the consumer-supplied signal to pool.acquire and connection.execute', async () => {
		const conn = fakeConnection({ execute: [{ kind: 'done' }] });
		const { pool } = fakePool(conn);
		const runner = poolRunner(pool);
		const ac = new AbortController();

		for await (const _ of runner.run({ sql: 'SELECT 1' }, ac.signal)) {
			// drain
		}

		assert.equal(pool.acquire.mock.calls[0]!.arguments[0], ac.signal);
		assert.equal(conn.execute.mock.calls[0]!.arguments[1], ac.signal);
	});

	test('forwards the request payload to connection.execute verbatim', async () => {
		const conn = fakeConnection({ execute: [{ kind: 'done' }] });
		const { pool } = fakePool(conn);
		const runner = poolRunner(pool);
		const req: ExecuteRequest = {
			sql: 'SELECT @p',
			params: [{ name: 'p', value: 42 }],
		};

		for await (const _ of runner.run(req)) {
			// drain
		}

		assert.equal(conn.execute.mock.calls[0]!.arguments[0], req);
	});

	test('releases the connection when the consumer breaks early (iter.return)', async () => {
		const conn = fakeConnection({
			execute: [
				{ kind: 'metadata', columns: [{ name: 'n' }] },
				{ kind: 'row', values: [1] },
				{ kind: 'row', values: [2] },
				{ kind: 'row', values: [3] },
				{ kind: 'rowsetEnd', rowsAffected: 3 },
				{ kind: 'done' },
			],
		});
		const { pool, release } = fakePool(conn);
		const runner = poolRunner(pool);

		let seen = 0;
		for await (const ev of runner.run({ sql: 'SELECT n FROM t' })) {
			if (ev.kind === 'row') {
				seen++;
				if (seen === 1) break;
			}
		}

		assert.equal(seen, 1, 'the loop should break after the first row');
		assert.equal(release.mock.callCount(), 1, 'release should fire despite the early break');
	});

	test('releases the connection when execute() throws mid-stream', async () => {
		const conn = fakeConnection({
			execute: () => { throw new Error('connection lost'); },
		});
		const { pool, release } = fakePool(conn);
		const runner = poolRunner(pool);

		await assert.rejects(
			async () => {
				for await (const _ of runner.run({ sql: 'SELECT 1' })) {
					// won't reach
				}
			},
			/connection lost/,
		);

		assert.equal(release.mock.callCount(), 1, 'release should fire despite the execute throw');
	});
});
