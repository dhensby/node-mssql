import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ClientClosedError,
	ClientNotConnectedError,
	MssqlError,
	PoolClosedError,
} from '../../src/errors/index.js';

describe('ClientClosedError', () => {
	test('extends MssqlError, not PoolError', () => {
		const err = new ClientClosedError('client closed', { state: 'destroyed' });
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof ClientClosedError);
		assert.equal(err.name, 'ClientClosedError');
		assert.equal(err.state, 'destroyed');
	});

	test('preserves PoolClosedError on .cause', () => {
		const inner = new PoolClosedError('draining', { state: 'draining' });
		const err = new ClientClosedError('client closed', { state: 'draining', cause: inner });
		assert.equal(err.cause, inner);
		assert.ok(err.cause instanceof PoolClosedError);
	});
});

describe('ClientNotConnectedError', () => {
	test('extends MssqlError with default message', () => {
		const err = new ClientNotConnectedError();
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof ClientNotConnectedError);
		assert.equal(err.name, 'ClientNotConnectedError');
		assert.equal(err.message, 'client is not connected');
	});

	test('accepts a custom message and standard fields', () => {
		const err = new ClientNotConnectedError('await client.connect() first', {
			connectionId: 'conn_1',
		});
		assert.equal(err.message, 'await client.connect() first');
		assert.equal(err.connectionId, 'conn_1');
	});
});
