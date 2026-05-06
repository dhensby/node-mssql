import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type ExecuteRequest,
	MultipleRowsetsError,
	Query,
	type RequestRunner,
	type ResultEvent,
} from '../../src/index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface RunnerLog {
	calls: number
	requests: ExecuteRequest[]
	signals: (AbortSignal | undefined)[]
	releases: number  // how many times the runner's try/finally fired
}

// Build a `RequestRunner` that yields a scripted sequence of `ResultEvent`s.
// Modelled on what the pool-bound runner will do (ADR-0023): the async
// generator's `try/finally` simulates `pool.release()` happening on stream
// end (drain or error). The `releases` counter on the log validates that
// release ran for whatever exit path the test exercises.
const makeFakeRunner = (
	events: ResultEvent[] | (() => ResultEvent[]),
): { runner: RequestRunner; log: RunnerLog } => {
	const log: RunnerLog = { calls: 0, requests: [], signals: [], releases: 0 };
	const runner: RequestRunner = {
		run(req, signal) {
			log.calls++;
			log.requests.push(req);
			log.signals.push(signal);
			return (async function* () {
				try {
					const evs = typeof events === 'function' ? events() : events;
					for (const event of evs) {
						yield event;
					}
				} finally {
					log.releases++;
				}
			})();
		},
	};
	return { runner, log };
};

const stmt = (sql: string): ExecuteRequest => ({ sql });

// ─── Construction & lazy execution ──────────────────────────────────────────

describe('Query — construction & lazy execution', () => {
	test('constructing a Query does not invoke the runner', () => {
		const { runner, log } = makeFakeRunner([]);
		new Query({ runner, request: stmt('SELECT 1') });
		assert.equal(log.calls, 0, 'runner was not called at construction');
	});

	test('runner is invoked when a terminal fires', async () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.all();
		assert.equal(log.calls, 1);
	});

	test('runner receives the configured ExecuteRequest', async () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const req: ExecuteRequest = { sql: 'SELECT @p', params: [{ name: 'p', value: 1 }] };
		await new Query({ runner, request: req }).all();
		assert.equal(log.requests[0], req);
	});

	test('runner receives the consumer-supplied AbortSignal', async () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const ac = new AbortController();
		await new Query({ runner, request: stmt('SELECT 1'), signal: ac.signal }).all();
		assert.equal(log.signals[0], ac.signal);
	});
});

// ─── PromiseLike (await) ────────────────────────────────────────────────────

describe('Query — PromiseLike', () => {
	test('`await query` resolves to the row array (.then delegates to .all)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const rows = await new Query<{ n: number }>({ runner, request: stmt('SELECT 1 AS n') });
		assert.deepEqual(rows, [{ n: 1 }]);
	});

	test('Promise.all on multiple Queries works (each Query awaits independently)', async () => {
		const { runner } = makeFakeRunner(() => [
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const [a, b] = await Promise.all([
			new Query({ runner, request: stmt('SELECT 1') }),
			new Query({ runner, request: stmt('SELECT 1') }),
		]);
		assert.deepEqual(a, [{ n: 1 }]);
		assert.deepEqual(b, [{ n: 1 }]);
	});
});

// ─── .all() — happy path ────────────────────────────────────────────────────

describe('Query.all() — single rowset', () => {
	test('returns rows shaped as objects keyed by column name', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }, { name: 'name' }] },
			{ kind: 'row', values: [1, 'alice'] },
			{ kind: 'row', values: [2, 'bob'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const rows = await new Query<{ id: number; name: string }>({
			runner,
			request: stmt('SELECT id, name FROM users'),
		}).all();
		assert.deepEqual(rows, [
			{ id: 1, name: 'alice' },
			{ id: 2, name: 'bob' },
		]);
	});

	test('empty rowset (metadata, no rows) returns []', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const rows = await new Query({ runner, request: stmt('SELECT id WHERE 0=1') }).all();
		assert.deepEqual(rows, []);
	});

	test('no rowset (DML, no metadata, no rows) returns []', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const rows = await new Query({ runner, request: stmt('UPDATE t SET x = 1') }).all();
		assert.deepEqual(rows, []);
	});

	test('row values arrive verbatim (no implicit type coercion at the kernel layer)', async () => {
		const date = new Date('2026-05-06T00:00:00Z');
		const buf = new Uint8Array([1, 2, 3]);
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'd' }, { name: 'b' }, { name: 'n' }] },
			{ kind: 'row', values: [date, buf, null] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const rows = await new Query<{ d: Date; b: Uint8Array; n: null }>({
			runner,
			request: stmt('SELECT d, b, n FROM t'),
		}).all();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.d, date, 'Date passed through');
		assert.equal(rows[0]?.b, buf, 'Uint8Array passed through');
		assert.equal(rows[0]?.n, null);
	});
});

// ─── Last-wins on duplicate column names (ADR-0007) ─────────────────────────

describe('Query.all() — duplicate column names', () => {
	test('collapses duplicate column names with last-wins semantics', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }, { name: 'id' }] },
			{ kind: 'row', values: [1, 2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const rows = await new Query<{ id: number }>({
			runner,
			request: stmt('SELECT a.id, b.id FROM a JOIN b ON ...'),
		}).all();
		assert.deepEqual(rows, [{ id: 2 }], 'last-wins: b.id overwrites a.id');
	});
});

// ─── Single-consumption guard ───────────────────────────────────────────────

describe('Query — single-consumption', () => {
	test('a second .all() call throws TypeError', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.all();
		await assert.rejects(() => q.all(), TypeError);
	});

	test('a second `await` throws TypeError', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q;
		await assert.rejects(async () => {
			await q;
		}, TypeError);
	});

	test('the guard fires synchronously on entry, before consuming the runner', async () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.all();
		assert.equal(log.calls, 1);
		await assert.rejects(() => q.all(), TypeError);
		assert.equal(log.calls, 1, 'second call did not invoke runner');
	});
});

// ─── MultipleRowsetsError ───────────────────────────────────────────────────

describe('Query.all() — multi-rowset detection', () => {
	test('throws MultipleRowsetsError when a second metadata token arrives', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'b' }] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		await assert.rejects(
			() => new Query({ runner, request: stmt('SELECT a; SELECT b') }).all(),
			MultipleRowsetsError,
		);
	});

	test('does not fire on a single rowset followed by trailer-only events', async () => {
		// `rowsetEnd` then trailer events (output, returnValue) but NO second
		// metadata — single rowset, just with extra trailer data.
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'output', name: 'x', value: 42 },
			{ kind: 'returnValue', value: 0 },
			{ kind: 'done' },
		]);
		const rows = await new Query({ runner, request: stmt('EXEC sp_x') }).all();
		assert.deepEqual(rows, [{ n: 1 }]);
	});
});

// ─── Error propagation + connection release ─────────────────────────────────

describe('Query — error propagation and release', () => {
	test('errors thrown by the runner stream propagate to the awaiter', async () => {
		const boom = new Error('connection lost');
		const runner: RequestRunner = {
			run(_req, _signal) {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'a' }] } satisfies ResultEvent;
					throw boom;
				})();
			},
		};
		await assert.rejects(
			() => new Query({ runner, request: stmt('SELECT a') }).all(),
			(err: unknown) => {
				assert.equal(err, boom);
				return true;
			},
		);
	});

	test('runner try/finally fires on natural drain (release-on-end)', async () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		await new Query({ runner, request: stmt('SELECT 1') }).all();
		assert.equal(log.releases, 1, 'try/finally ran exactly once');
	});

	test('runner try/finally fires on stream error (release-on-error)', async () => {
		const log = { releases: 0 };
		const runner: RequestRunner = {
			run(_req, _signal) {
				return (async function* () {
					try {
						yield { kind: 'metadata', columns: [{ name: 'a' }] } satisfies ResultEvent;
						throw new Error('mid-stream failure');
					} finally {
						log.releases++;
					}
				})();
			},
		};
		await assert.rejects(
			() => new Query({ runner, request: stmt('SELECT a') }).all(),
			/mid-stream failure/,
		);
		assert.equal(log.releases, 1, 'finally ran despite error');
	});

	test('runner try/finally fires when MultipleRowsetsError throws inside Query', async () => {
		// The error is thrown by Query (not by the runner), but the for-await
		// loop's `iter.return()` should still trigger the runner's finally.
		// This is the validation that the async-generator pattern works for
		// in-Query throws too.
		const log = { releases: 0 };
		const runner: RequestRunner = {
			run(_req, _signal) {
				return (async function* () {
					try {
						yield { kind: 'metadata', columns: [{ name: 'a' }] } satisfies ResultEvent;
						yield { kind: 'rowsetEnd', rowsAffected: 1 } satisfies ResultEvent;
						yield { kind: 'metadata', columns: [{ name: 'b' }] } satisfies ResultEvent;
						yield { kind: 'done' } satisfies ResultEvent;
					} finally {
						log.releases++;
					}
				})();
			},
		};
		await assert.rejects(
			() => new Query({ runner, request: stmt('SELECT a; SELECT b') }).all(),
			MultipleRowsetsError,
		);
		assert.equal(
			log.releases,
			1,
			'for-await loop calling iter.return() on Query-internal throw triggers the runner finally',
		);
	});
});
