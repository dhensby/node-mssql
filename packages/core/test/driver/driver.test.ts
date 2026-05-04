import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type {
	Connection,
	ConnectionEvents,
	Driver,
	DriverOptions,
	ExecuteRequest,
	ResultEvent,
} from '../../src/driver/index.js';

class FakeConnection
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id = 'conn_test_1';

	async *execute(_req: ExecuteRequest): AsyncIterable<ResultEvent> {
		yield { kind: 'done' };
	}
	async beginTransaction(): Promise<void> {}
	async commit(): Promise<void> {}
	async rollback(): Promise<void> {}
	async savepoint(): Promise<void> {}
	async rollbackToSavepoint(): Promise<void> {}
	async prepare(): Promise<{ id: string }> {
		return { id: 'prep_1' };
	}
	async bulkLoad(): Promise<{ rowsAffected: number }> {
		return { rowsAffected: 0 };
	}
	async reset(): Promise<void> {}
	async ping(): Promise<void> {}
	async close(): Promise<void> {}
}

const fakeDriver: Driver = {
	name: 'fake',
	types: {},
	async open(_opts: DriverOptions): Promise<Connection> {
		return new FakeConnection();
	},
};

describe('Driver port', () => {
	test('interface implementable by a fake adapter', async () => {
		assert.equal(fakeDriver.name, 'fake');
		assert.equal(typeof fakeDriver.open, 'function');

		const conn = await fakeDriver.open({
			credential: { kind: 'integrated' },
			transport: { host: 'db.local' },
		});
		assert.equal(conn.id, 'conn_test_1');
	});

	test('Connection.execute produces AsyncIterable<ResultEvent>', async () => {
		const conn = await fakeDriver.open({
			credential: { kind: 'integrated' },
			transport: { host: 'db.local' },
		});
		const events: ResultEvent[] = [];
		for await (const ev of conn.execute({ sql: 'select 1' })) {
			events.push(ev);
		}
		assert.equal(events.length, 1);
		assert.equal(events[0]?.kind, 'done');
	});
});
