import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { onceAsync, withResolvers } from '../../src/util/index.js';

describe('onceAsync()', () => {
	test('runs the operation at most once across many calls', async () => {
		const op = mock.fn(async () => 'result');
		const once = onceAsync(op);
		await Promise.all([once(), once(), once()]);
		await once();
		assert.equal(op.mock.callCount(), 1);
	});

	test('hands every caller the same promise', () => {
		const once = onceAsync(async () => 'x');
		assert.equal(once(), once());
	});

	test('resolves with the operation result', async () => {
		const once = onceAsync(async () => 42);
		assert.equal(await once(), 42);
	});

	test('concurrent callers share one settlement (no premature done)', async () => {
		const { promise: gate, resolve: release } = withResolvers<void>();
		const op = mock.fn(async () => {
			await gate;
			return 'done';
		});
		const once = onceAsync(op);
		const a = once();
		const b = once();
		release();
		assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
		assert.equal(op.mock.callCount(), 1);
	});

	test('caches a rejection — a failed settle is terminal, not retried', async () => {
		const boom = new Error('settle failed');
		const op = mock.fn(async () => {
			throw boom;
		});
		const once = onceAsync(op);
		await assert.rejects(() => once(), (err) => err === boom);
		await assert.rejects(() => once(), (err) => err === boom);
		assert.equal(op.mock.callCount(), 1, 'op not re-run after a cached rejection');
	});
});
