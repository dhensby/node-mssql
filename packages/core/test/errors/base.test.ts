import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MssqlError } from '../../src/errors/index.js';

describe('MssqlError', () => {
	test('message, name, instanceof Error', () => {
		const err = new MssqlError('boom');
		assert.equal(err.message, 'boom');
		assert.equal(err.name, 'MssqlError');
		assert.ok(err instanceof Error);
		assert.ok(err instanceof MssqlError);
	});

	test('connectionId/queryId/poolId populated when given', () => {
		const err = new MssqlError('x', { connectionId: 'conn_1', queryId: 'q_2', poolId: 'pool_3' });
		assert.equal(err.connectionId, 'conn_1');
		assert.equal(err.queryId, 'q_2');
		assert.equal(err.poolId, 'pool_3');
	});

	test('fields absent when not provided', () => {
		const err = new MssqlError('x');
		assert.equal(err.connectionId, undefined);
		assert.equal(err.queryId, undefined);
		assert.equal(err.poolId, undefined);
	});

	test('preserves ES2022 cause', () => {
		const inner = new Error('inner');
		const err = new MssqlError('outer', { cause: inner });
		assert.equal(err.cause, inner);
	});
});
