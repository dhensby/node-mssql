import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResultEvent } from '../../src/driver/index.js';
import { fakeDriver } from '../support/fakes.js';

const driver = fakeDriver();

describe('Driver port', () => {
	test('interface implementable by a fake adapter', async () => {
		assert.equal(driver.name, 'fake');
		assert.equal(typeof driver.open, 'function');

		const conn = await driver.open({
			credential: { kind: 'integrated' },
			transport: { host: 'db.local' },
		});
		assert.equal(conn.id, 'conn_fake');
	});

	test('Connection.execute produces AsyncIterable<ResultEvent>', async () => {
		const conn = await driver.open({
			credential: { kind: 'integrated' },
			transport: { host: 'db.local' },
		});
		const events: ResultEvent[] = [];
		for await (const ev of conn.execute({ sql: 'select 1' })) {
			events.push(ev);
		}
		assert.equal(events.length, 1);
		assert.equal(events[0]!.kind, 'done');
	});
});
