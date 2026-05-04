import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	defaultIdGenerator,
	ID_PREFIXES,
	nextId,
	PROCESS_TAG,
	type IdGenerator,
} from '../../src/ids/index.js';

describe('object id generator', () => {
	test('PROCESS_TAG is 10 lowercase hex chars', () => {
		assert.match(PROCESS_TAG, /^[0-9a-f]{10}$/);
	});

	test('defaultIdGenerator formats as prefix_TAG_counter', () => {
		assert.equal(defaultIdGenerator('conn', 7), `conn_${PROCESS_TAG}_7`);
	});

	test('nextId increments per prefix', () => {
		const a = nextId('req');
		const b = nextId('req');
		const prefix = `req_${PROCESS_TAG}_`;
		assert.ok(a.startsWith(prefix));
		assert.ok(b.startsWith(prefix));
		const aN = Number(a.slice(prefix.length));
		const bN = Number(b.slice(prefix.length));
		assert.ok(bN === aN + 1, `expected ${aN} + 1 === ${bN}`);
	});

	test('counters are independent across prefixes', () => {
		const conn1 = nextId('conn');
		const tx1 = nextId('tx');
		const conn2 = nextId('conn');
		const connPrefix = `conn_${PROCESS_TAG}_`;
		const txPrefix = `tx_${PROCESS_TAG}_`;
		assert.ok(conn1.startsWith(connPrefix));
		assert.ok(tx1.startsWith(txPrefix));
		assert.ok(conn2.startsWith(connPrefix));
		const conn1N = Number(conn1.slice(connPrefix.length));
		const conn2N = Number(conn2.slice(connPrefix.length));
		assert.equal(conn2N, conn1N + 1);
	});

	test('nextId passes (prefix, counter) to custom generator', () => {
		const calls: [string, number][] = [];
		const custom: IdGenerator = (prefix, counter) => {
			calls.push([prefix, counter]);
			return `${prefix}-${counter}`;
		};
		const first = nextId('pool', custom);
		const second = nextId('pool', custom);
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.[0], 'pool');
		assert.equal(calls[1]?.[0], 'pool');
		const firstN = calls[0]?.[1] ?? 0;
		const secondN = calls[1]?.[1] ?? 0;
		assert.equal(secondN, firstN + 1);
		assert.equal(first, `pool-${firstN}`);
		assert.equal(second, `pool-${secondN}`);
	});

	test('custom generator shares the counter state with defaults', () => {
		const first = nextId('sp');
		const second = nextId('sp', (_p, n) => `custom-${n}`);
		const prefix = `sp_${PROCESS_TAG}_`;
		assert.ok(first.startsWith(prefix));
		const firstN = Number(first.slice(prefix.length));
		assert.equal(second, `custom-${firstN + 1}`);
	});

	test('ID_PREFIXES matches the ADR prefix set', () => {
		assert.deepEqual([...ID_PREFIXES], ['conn', 'pool', 'req', 'tx', 'sp', 'prep', 'bulk']);
	});
});
