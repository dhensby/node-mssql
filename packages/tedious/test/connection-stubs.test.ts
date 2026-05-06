// Stub-method tests for `TediousConnectionWrapper`.
//
// V-3 ships only `execute` / `close` / `reset` / `ping` from the
// `Connection` driver-port surface. The remaining methods —
// transactions, prepared statements, bulk-load — throw
// "not yet implemented" so users hitting them get a clear pointer to
// the round-out commits, not a silent no-op or a confusing tedious
// error. These tests pin that contract so a future round-out commit
// can't accidentally land a partial implementation that drops the
// helpful error.
//
// As each stub is replaced by a real implementation, the matching
// test moves to a real-DB integration test.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection as TediousConnection } from 'tedious';
import { TediousConnectionWrapper } from '../src/connection.js';

// We don't connect — we just need a Connection-shaped object to
// instantiate the wrapper. The stub methods throw without touching the
// underlying tedious connection. Using `Object.create` to skip
// construction-time work; tedious's Connection constructor would try
// to validate config.
const dummyTedious = Object.create(TediousConnection.prototype) as TediousConnection;

const wrapper = new TediousConnectionWrapper(dummyTedious, 'conn_stub');

describe('TediousConnectionWrapper — stubs throw with helpful messages', () => {
	test('beginTransaction() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.beginTransaction(), /beginTransaction.*not yet implemented/);
	});

	test('commit() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.commit(), /commit.*not yet implemented/);
	});

	test('rollback() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.rollback(), /rollback.*not yet implemented/);
	});

	test('savepoint() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.savepoint(), /savepoint.*not yet implemented/);
	});

	test('rollbackToSavepoint() throws "not yet implemented"', async () => {
		await assert.rejects(
			() => wrapper.rollbackToSavepoint(),
			/rollbackToSavepoint.*not yet implemented/,
		);
	});

	test('prepare() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.prepare(), /prepare.*not yet implemented/);
	});

	test('bulkLoad() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.bulkLoad(), /bulkLoad.*not yet implemented/);
	});
});
