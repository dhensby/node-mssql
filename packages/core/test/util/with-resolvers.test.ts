import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withResolvers } from '../../src/util/index.js';

describe('withResolvers()', () => {
	test('returns a pending promise plus its resolve/reject', () => {
		const d = withResolvers<number>();
		assert.equal(typeof d.promise.then, 'function');
		assert.equal(typeof d.resolve, 'function');
		assert.equal(typeof d.reject, 'function');
	});

	test('resolve() settles the promise with the value (from outside the executor)', async () => {
		const { promise, resolve } = withResolvers<number>();
		resolve(42);
		assert.equal(await promise, 42);
	});

	test('resolve() adopts a thenable', async () => {
		const { promise, resolve } = withResolvers<string>();
		resolve(Promise.resolve('adopted'));
		assert.equal(await promise, 'adopted');
	});

	test('reject() rejects the promise with the reason', async () => {
		const { promise, reject } = withResolvers<void>();
		const boom = new Error('boom');
		reject(boom);
		await assert.rejects(() => promise, (err) => err === boom);
	});

	test('first settle wins — a later resolve/reject is a no-op', async () => {
		const { promise, resolve, reject } = withResolvers<string>();
		resolve('first');
		resolve('second');
		reject(new Error('too late'));
		assert.equal(await promise, 'first');
	});

	test('each call produces an independent deferred', async () => {
		const a = withResolvers<string>();
		const b = withResolvers<string>();
		a.resolve('a');
		b.resolve('b');
		assert.deepEqual(await Promise.all([a.promise, b.promise]), ['a', 'b']);
	});
});
