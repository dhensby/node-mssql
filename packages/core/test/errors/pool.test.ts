import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MssqlError,
	PoolClosedError,
	PoolError,
} from '../../src/errors/index.js';

describe('PoolError', () => {
	test('extends MssqlError', () => {
		const err = new PoolError('pool exploded');
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof PoolError);
		assert.equal(err.name, 'PoolError');
	});
});

describe('PoolClosedError', () => {
	test('carries state', () => {
		const err = new PoolClosedError('draining', { state: 'draining' });
		assert.ok(err instanceof PoolError);
		assert.ok(err instanceof PoolClosedError);
		assert.equal(err.name, 'PoolClosedError');
		assert.equal(err.state, 'draining');
	});
});
