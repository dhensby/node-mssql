// Tests for `Query<T>.rowsets<Tuple>()` — the multi-rowset terminal
// (ADR-0006). The terminal returns a `Rowsets<Tuple>` that is BOTH
// thenable and async-iterable; the user picks consumption mode by how
// they consume it:
//
//   const [users, orders] = await q.rowsets<[User, Order]>()
//   for await (const rs of q.rowsets<[User, Order]>()) { ... }
//
// Awaited form materialises into a tuple `[User[], Order[]]`.
// Iterated form yields one inner `AsyncIterable` per rowset, in order.
//
// Break semantics:
// - Inner break: drains remaining rows of current rowset, then yields
//   the NEXT rowset. The request continues.
// - Outer break: cancels the underlying request via the runner's
//   `iter.return()` chain. No further reads from the wire.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type ExecuteRequest,
	Query,
	type RequestRunner,
	type ResultEvent,
} from '../../src/index.js';

interface RunnerLog {
	calls: number
	releases: number
}

const makeFakeRunner = (
	events: ResultEvent[],
): { runner: RequestRunner; log: RunnerLog } => {
	const log: RunnerLog = { calls: 0, releases: 0 };
	const runner: RequestRunner = {
		run() {
			log.calls++;
			return (async function* () {
				try {
					for (const e of events) yield e;
				} finally {
					log.releases++;
				}
			})();
		},
	};
	return { runner, log };
};

const stmt = (sql: string): ExecuteRequest => ({ sql });

// ─── Buffered (awaited) form ────────────────────────────────────────────────

describe('Query.rowsets() — buffered (awaited) form', () => {
	test('await yields a tuple of arrays, one per rowset', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }, { name: 'name' }] },
			{ kind: 'row', values: [1, 'alice'] },
			{ kind: 'row', values: [2, 'bob'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'metadata', columns: [{ name: 'orderId' }, { name: 'amount' }] },
			{ kind: 'row', values: [10, 99] },
			{ kind: 'row', values: [11, 50] },
			{ kind: 'row', values: [12, 25] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT id, name FROM u; SELECT orderId, amount FROM o') });
		const [users, orders] = await q.rowsets<[
			{ id: number; name: string },
			{ orderId: number; amount: number },
		]>();
		assert.deepEqual(users, [
			{ id: 1, name: 'alice' },
			{ id: 2, name: 'bob' },
		]);
		assert.deepEqual(orders, [
			{ orderId: 10, amount: 99 },
			{ orderId: 11, amount: 50 },
			{ orderId: 12, amount: 25 },
		]);
	});

	test('returns a single-element tuple for a single-rowset query', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1 AS n') });
		const result = await q.rowsets<[{ n: number }]>();
		assert.deepEqual(result, [[{ n: 1 }]]);
	});

	test('returns an empty tuple for a query with no rowsets (DML)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t SET x = 1 WHERE 0 = 1') });
		const result = await q.rowsets();
		assert.deepEqual(result, []);
	});

	test('runner finally fires on natural drain', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a') });
		await q.rowsets();
		assert.equal(log.releases, 1);
	});

	test('propagates stream errors as rejection', async () => {
		const boom = new Error('mid-stream');
		const runner: RequestRunner = {
			run() {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'a' }] } satisfies ResultEvent;
					throw boom;
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT a') });
		await assert.rejects(async () => { await q.rowsets(); }, /mid-stream/);
	});

	test('.raw() mode buffers tuples instead of objects', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }, { name: 'b' }] },
			{ kind: 'row', values: [1, 'x'] },
			{ kind: 'row', values: [2, 'y'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a, b FROM t') });
		const result = await q.raw<[number, string]>().rowsets<[[number, string]]>();
		assert.deepEqual(result, [[[1, 'x'], [2, 'y']]]);
	});

	test('preserves duplicate-column values via raw mode (positional tuples)', async () => {
		// Default object mode collapses dup names last-wins; raw preserves
		// all values.
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'x' }, { name: 'x' }] },
			{ kind: 'row', values: [1, 2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1 AS x, 2 AS x') });
		const result = await q.raw<[number, number]>().rowsets<[[number, number]]>();
		assert.deepEqual(result, [[[1, 2]]]);
	});

	test('updates trailer alongside row buffering — meta() reflects rowsAffected', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'b' }] },
			{ kind: 'row', values: [2] },
			{ kind: 'row', values: [3] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a; SELECT b') });
		await q.rowsets();
		const meta = q.meta();
		assert.equal(meta.completed, true);
		assert.equal(meta.rowsAffected, 3);
		assert.deepEqual(meta.rowsAffectedPerStatement, [1, 2]);
	});
});

// ─── Streamed (iterated) form ───────────────────────────────────────────────

describe('Query.rowsets() — streamed (iterated) form', () => {
	test('for await yields one inner AsyncIterable per rowset, in order', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'metadata', columns: [{ name: 'm' }] },
			{ kind: 'row', values: [10] },
			{ kind: 'row', values: [20] },
			{ kind: 'row', values: [30] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n; SELECT m') });
		const collected: unknown[][] = [];
		for await (const rs of q.rowsets()) {
			const rows: unknown[] = [];
			for await (const row of rs) rows.push(row);
			collected.push(rows);
		}
		assert.deepEqual(collected, [
			[{ n: 1 }, { n: 2 }],
			[{ m: 10 }, { m: 20 }, { m: 30 }],
		]);
	});

	test('inner-break drains remaining rows of current rowset; outer continues to next', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'row', values: [3] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'metadata', columns: [{ name: 'm' }] },
			{ kind: 'row', values: [10] },
			{ kind: 'row', values: [20] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n; SELECT m') });
		const collected: unknown[][] = [];
		let outerIndex = 0;
		for await (const rs of q.rowsets()) {
			const rows: unknown[] = [];
			for await (const row of rs) {
				rows.push(row);
				// Break ONLY on the first rowset — the second should be
				// consumed in full to verify it's delivered intact after
				// the first rowset's drain.
				if (outerIndex === 0 && rows.length === 1) break;
			}
			collected.push(rows);
			outerIndex++;
		}
		// First rowset broken at row 1; library drained the remaining 2 rows
		// of that rowset. Second rowset delivered intact.
		assert.deepEqual(collected, [
			[{ n: 1 }],
			[{ m: 10 }, { m: 20 }],
		]);
		// Natural drain at end fires runner finally.
		assert.equal(log.releases, 1);
	});

	test('outer-break cancels the underlying request (runner finally fires once)', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'm' }] },
			{ kind: 'row', values: [10] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n; SELECT m') });
		let outerCount = 0;
		for await (const rs of q.rowsets()) {
			outerCount++;
			// Drain inner naturally, then break the outer.
			for await (const _row of rs) { /* */ }
			break;
		}
		assert.equal(outerCount, 1);
		assert.equal(log.releases, 1, 'outer-break triggers runner finally');
	});

	test('outer-break before consuming inner cancels cleanly', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		let saw = 0;
		for await (const _rs of q.rowsets()) {
			saw++;
			break;
		}
		assert.equal(saw, 1);
		assert.equal(log.releases, 1);
	});

	test('streamed form yields rowsetN-shaped rows for raw queries', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }, { name: 's' }] },
			{ kind: 'row', values: [1, 'a'] },
			{ kind: 'row', values: [2, 'b'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n, s FROM t') });
		const collected: unknown[][] = [];
		for await (const rs of q.raw<[number, string]>().rowsets<[[number, string]]>()) {
			const rows: unknown[] = [];
			for await (const row of rs) rows.push(row);
			collected.push(rows);
		}
		assert.deepEqual(collected, [[[1, 'a'], [2, 'b']]]);
	});

	test('streamed form for empty (no-rowsets) queries does not yield anything', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t SET x = 1 WHERE 0 = 1') });
		let count = 0;
		for await (const _rs of q.rowsets()) count++;
		assert.equal(count, 0);
	});

	test('trailer events arriving mid-rowset are skipped by row delivery (and accumulated upstream)', async () => {
		// info / print / envChange / output / returnValue events that land
		// between rows should be transparent to the row-consuming path —
		// the inner iterator skips them and continues delivering rows.
		// The Query's #observeEvent accumulates them into the trailer.
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'info', number: 1, state: 1, class: 1, message: 'mid-rowset notice' },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n') });
		const collected: { n: number }[] = [];
		for await (const rs of q.rowsets<[{ n: number }]>()) {
			for await (const row of rs) collected.push(row as { n: number });
		}
		assert.deepEqual(collected, [{ n: 1 }, { n: 2 }]);
		const meta = q.meta();
		assert.equal(meta.info.length, 1, 'info accumulated to trailer');
		assert.equal(meta.info[0]?.message, 'mid-rowset notice');
	});
});

// ─── Single-consumption (Query and Rowsets layers) ──────────────────────────

describe('Query.rowsets() — single consumption', () => {
	test('rowsets() after .all() throws (Query consumed)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.all();
		assert.throws(() => q.rowsets(), TypeError);
	});

	test('.all() after rowsets() throws (Query consumed)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.rowsets();
		await assert.rejects(() => q.all(), TypeError);
	});

	test('awaiting AND iterating the same Rowsets throws on the second consumption', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		const rs = q.rowsets();
		await rs;
		assert.throws(() => rs[Symbol.asyncIterator](), TypeError);
	});

	test('iterating then awaiting the same Rowsets throws on the second consumption', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		const rs = q.rowsets();
		for await (const _x of rs) { /* */ }
		await assert.rejects(() => Promise.resolve(rs), TypeError);
	});

	test('rowsets() on a disposed Query throws', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.dispose();
		assert.throws(() => q.rowsets(), TypeError);
	});
});

// ─── Error propagation ──────────────────────────────────────────────────────

describe('Query.rowsets() — error propagation', () => {
	test('error before any metadata rejects buffered form', async () => {
		const boom = new Error('connection lost');
		const runner: RequestRunner = {
			run() {
				const iter: AsyncIterableIterator<ResultEvent> = {
					[Symbol.asyncIterator]() { return this; },
					next() { return Promise.reject(boom); },
				};
				return iter;
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		// `q.rowsets()` is sync (returns a Rowsets); awaiting it resolves
		// via the thenable's `then`. Wrap in an async lambda so
		// `assert.rejects` sees a Promise<unknown>.
		await assert.rejects(async () => { await q.rowsets(); }, /connection lost/);
	});

	test('error mid-rowset surfaces on the inner iterator throw', async () => {
		const boom = new Error('mid-rowset');
		const runner: RequestRunner = {
			run() {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'n' }] } satisfies ResultEvent;
					yield { kind: 'row', values: [1] } satisfies ResultEvent;
					throw boom;
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT n') });
		await assert.rejects(async () => {
			for await (const rs of q.rowsets()) {
				for await (const _row of rs) { /* */ }
			}
		}, /mid-rowset/);
	});
});
