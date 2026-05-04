import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
	AbortError,
	abortErrorFromSignal,
	MssqlError,
	TimeoutError,
} from '../../src/errors/index.js';

describe('AbortError', () => {
	test('name "AbortError", extends MssqlError, carries phase', () => {
		const err = new AbortError('aborted', { phase: 'response' });
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof AbortError);
		assert.equal(err.name, 'AbortError');
		assert.equal(err.phase, 'response');
	});
});

describe('TimeoutError', () => {
	test('name "TimeoutError", extends MssqlError, carries phase', () => {
		const err = new TimeoutError('timed out', { phase: 'pool-acquire' });
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof TimeoutError);
		assert.equal(err.name, 'TimeoutError');
		assert.equal(err.phase, 'pool-acquire');
	});
});

describe('abortErrorFromSignal', () => {
	test('AbortSignal.timeout() reason produces TimeoutError', async () => {
		const signal = AbortSignal.timeout(1);
		await delay(5);
		assert.ok(signal.aborted);
		const err = abortErrorFromSignal(signal, { phase: 'response' });
		assert.ok(err instanceof TimeoutError);
		assert.equal(err.name, 'TimeoutError');
		assert.equal(err.cause, signal.reason);
		assert.equal(err.phase, 'response');
	});

	test('controller.abort() reason produces AbortError', () => {
		const controller = new AbortController();
		controller.abort();
		const err = abortErrorFromSignal(controller.signal, { phase: 'dispatch' });
		assert.ok(err instanceof AbortError);
		assert.equal(err.name, 'AbortError');
		assert.equal(err.cause, controller.signal.reason);
		assert.equal(err.phase, 'dispatch');
	});

	test('custom reason with name "TimeoutError" produces TimeoutError', () => {
		const controller = new AbortController();
		const reason = new DOMException('deadline', 'TimeoutError');
		controller.abort(reason);
		const err = abortErrorFromSignal(controller.signal, { phase: 'connect' });
		assert.ok(err instanceof TimeoutError);
		assert.equal(err.cause, reason);
		assert.equal(err.phase, 'connect');
	});

	test('passes through connectionId / queryId', () => {
		const controller = new AbortController();
		controller.abort();
		const err = abortErrorFromSignal(controller.signal, {
			connectionId: 'conn_1',
			queryId: 'q_1',
			phase: 'response',
		});
		assert.equal(err.connectionId, 'conn_1');
		assert.equal(err.queryId, 'q_1');
	});
});
