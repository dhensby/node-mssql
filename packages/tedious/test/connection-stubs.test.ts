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

// The savepoint name reaches the server in a binary TDS token (no SQL
// injection surface), but it must still be a valid ≤32-char savepoint
// identifier. The driver validates defensively at the wire boundary,
// independent of the caller or a future custom id generator (ADR-0016).
// The guard throws before any connection interaction, so these run
// against the dummy connection without a live server.
describe('TediousConnectionWrapper — savepoint name guard', () => {
	const unsafe: Record<string, string> = {
		'a space': 'sp bad',
		'a semicolon (injection-shaped)': 'sp;ROLLBACK',
		'a leading digit': '1sp',
		empty: '',
		'over 32 chars': 'a'.repeat(33),
		'a dash': 'sp-1',
		'a quote': "sp'x",
	};

	for (const [why, name] of Object.entries(unsafe)) {
		test(`savepoint() rejects ${why}`, async () => {
			await assert.rejects(() => wrapper.savepoint(name), /Invalid savepoint name/);
		});
		test(`rollbackToSavepoint() rejects ${why}`, async () => {
			await assert.rejects(() => wrapper.rollbackToSavepoint(name), /Invalid savepoint name/);
		});
	}

	test('the library-generated format passes the guard', async () => {
		// A name of the shape `savepointName()` produces is accepted by the
		// guard; with no live connection the underlying tedious call fails,
		// but NOT with the guard's message — proving the name got through.
		await assert.rejects(
			() => wrapper.savepoint('sp_0123456789_42'),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.doesNotMatch(err.message, /Invalid savepoint name/);
				return true;
			},
		);
	});
});
