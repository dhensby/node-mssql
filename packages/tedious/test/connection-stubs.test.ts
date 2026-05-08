// Stub-method tests for `TediousConnectionWrapper`.
//
// V-3 shipped `execute` / `close` / `reset` / `ping`; R-6 added the
// transaction set (`beginTransaction` / `commit` / `rollback` /
// `savepoint` / `rollbackToSavepoint`) — covered by integration tests
// against a real server.
//
// The remaining stubs (`prepare`, `bulkLoad`) throw "not yet
// implemented" so users hitting them get a clear pointer to the
// round-out commits rather than a silent no-op or a confusing tedious
// error. These tests pin that contract; as each stub is replaced by a
// real implementation, the matching test moves to a real-DB
// integration test.

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
	test('prepare() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.prepare(), /prepare.*not yet implemented/);
	});

	test('bulkLoad() throws "not yet implemented"', async () => {
		await assert.rejects(() => wrapper.bulkLoad(), /bulkLoad.*not yet implemented/);
	});
});
