import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DriverError,
	MssqlError,
	TransactionError,
} from '../../src/errors/index.js';

describe('TransactionError', () => {
	test('extends MssqlError, name set', () => {
		const err = new TransactionError('nested transaction rejected');
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof TransactionError);
		assert.equal(err.name, 'TransactionError');
	});
});

describe('DriverError', () => {
	test('extends MssqlError, wraps cause', () => {
		const inner = new Error('tedious internal state');
		const err = new DriverError('unexpected driver failure', { cause: inner });
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof DriverError);
		assert.equal(err.name, 'DriverError');
		assert.equal(err.cause, inner);
	});
});
