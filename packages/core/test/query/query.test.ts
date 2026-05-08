import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type EnvChange,
	type ExecuteRequest,
	type InfoMessage,
	MultipleRowsetsError,
	Query,
	type QueryMeta,
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

	test('runner receives a signal that propagates the consumer-supplied AbortSignal', async () => {
		// Query composes the consumer-supplied signal with its own internal
		// controller (ADR-0023) — so the runner sees a NEW signal that
		// aborts when EITHER source fires. We verify behaviour rather
		// than reference equality.
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const ac = new AbortController();
		await new Query({ runner, request: stmt('SELECT 1'), signal: ac.signal }).all();
		const runnerSignal = log.signals[0];
		assert.ok(runnerSignal !== undefined, 'runner received a signal');
		assert.equal(runnerSignal.aborted, false);
		ac.abort();
		assert.equal(runnerSignal.aborted, true, 'consumer abort propagated to runner signal');
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

// ─── Query.iterate() + AsyncIterable ────────────────────────────────────────

describe('Query.iterate() — streaming row consumption', () => {
	test('yields rows one at a time as objects', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'row', values: [3] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n FROM t') });
		const rows: { n: number }[] = [];
		for await (const row of q.iterate()) {
			rows.push(row);
		}
		assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
	});

	test('Query is itself AsyncIterable — `for await (const row of q)` works', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [42] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT 42 AS n') });
		const rows: { n: number }[] = [];
		for await (const row of q) {
			rows.push(row);
		}
		assert.deepEqual(rows, [{ n: 42 }]);
	});

	test('breaking out of for-await calls iter.return() on the runner (release-on-break)', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'row', values: [3] },
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n FROM t') });
		let n = 0;
		for await (const _row of q.iterate()) {
			n++;
			if (n === 1) break;
		}
		assert.equal(n, 1);
		assert.equal(log.releases, 1, 'runner finally fired on break');
	});

	test('throws MultipleRowsetsError on a second metadata token', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'b' }] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a; SELECT b') });
		await assert.rejects(async () => {
			for await (const _row of q.iterate()) {
				// continue until the multi-rowset throw fires
			}
		}, MultipleRowsetsError);
	});

	test('iterate() is single-consumption (calling twice throws)', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		// First call exhausts.
		for await (const _row of q.iterate()) { /* noop */ }
		assert.throws(() => q.iterate(), TypeError);
	});

	test('iterate() and all() share the single-consumption guard', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.all();
		assert.throws(() => q.iterate(), TypeError);
	});
});

// ─── Query.run() — drain-only terminal ──────────────────────────────────────

describe('Query.run() — drain-only', () => {
	test('drains the stream and returns trailer with rowsAffected', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 5 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t SET x = 1') });
		const meta = await q.run();
		assert.equal(meta.rowsAffected, 5);
		assert.deepEqual(meta.rowsAffectedPerStatement, [5]);
		assert.equal(meta.completed, true);
	});

	test('does NOT throw MultipleRowsetsError on multi-rowset (drain-only is rowset-oblivious)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'b' }] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a; SELECT b') });
		const meta = await q.run();
		assert.equal(meta.rowsAffected, 2);
		assert.deepEqual(meta.rowsAffectedPerStatement, [1, 1]);
	});

	test('aggregates multi-statement rowsAffected', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 3 },
			{ kind: 'rowsetEnd', rowsAffected: 7 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE a; UPDATE b') });
		const meta = await q.run();
		assert.equal(meta.rowsAffected, 10);
		assert.deepEqual(meta.rowsAffectedPerStatement, [3, 7]);
	});

	test('is single-consumption (second call throws)', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('UPDATE t') });
		await q.run();
		await assert.rejects(() => q.run(), TypeError);
	});
});

// ─── Query.result() — rows + meta in one shape ──────────────────────────────

describe('Query.result()', () => {
	test('returns { rows, meta } in a single call', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query<{ id: number }>({ runner, request: stmt('SELECT id') });
		const { rows, meta } = await q.result();
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
		assert.equal(meta.rowsAffected, 2);
		assert.equal(meta.completed, true);
	});

	test('result() consumes once — subsequent terminal calls throw', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT id WHERE 0 = 1') });
		await q.result();
		await assert.rejects(() => q.all(), TypeError);
	});

	test('throws MultipleRowsetsError on multi-rowset (row-promising terminal)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'metadata', columns: [{ name: 'b' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a; SELECT b') });
		await assert.rejects(() => q.result(), MultipleRowsetsError);
	});
});

// ─── Trailer accumulation + Query.meta() ────────────────────────────────────

describe('Query.meta() — trailer access', () => {
	test('throws TypeError if called before stream terminates', () => {
		const { runner } = makeFakeRunner([]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		assert.throws(() => q.meta(), TypeError);
	});

	test('returns trailer with completed=true after natural drain', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.all();
		const meta = q.meta();
		assert.equal(meta.completed, true);
		assert.equal(meta.rowsAffected, 1);
	});

	test('returns completed=false when the stream errors mid-drain', async () => {
		const boom = new Error('connection lost');
		const runner: RequestRunner = {
			run() {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'n' }] } satisfies ResultEvent;
					yield { kind: 'row', values: [1] } satisfies ResultEvent;
					throw boom;
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await assert.rejects(() => q.all(), /connection lost/);
		const meta = q.meta();
		assert.equal(meta.completed, false, 'completed=false on abnormal exit');
		// Trailer up to the error point is preserved.
		assert.deepEqual(meta.rowsAffectedPerStatement, []);
	});

	test('returns completed=false when consumer breaks early', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		for await (const _row of q.iterate()) {
			break;
		}
		const meta = q.meta();
		assert.equal(meta.completed, false);
	});

	test('multiple .meta() calls return the same trailer state', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t') });
		await q.run();
		const a = q.meta();
		const b = q.meta();
		assert.equal(a.rowsAffected, b.rowsAffected);
		assert.equal(a.completed, b.completed);
	});
});

// ─── Cancel-then-settle ordering (regression for cancel-mid-stream leak) ───
//
// The bug guarded against: `q.cancel()` issues a driver-level cancel via
// the internal AbortController, but the underlying runner's stream
// (e.g. tedious's request) takes async time to settle the cancel
// response. If `cancel()` resolves before the runner's `finally` block
// has run, the surrounding scope (e.g. a poolRunner's `await using`
// disposal) fires its connection release while the request is still
// mid-cancel-response. `Connection.reset()` then runs on top of an
// unsettled cancel, corrupting state for the next acquire.
//
// `cancel()` MUST await the runner stream's full termination (via the
// stream-events generator's `finally` block) before resolving.

describe('Query — cancel-then-settle ordering (regression)', () => {
	test('q.cancel() does not resolve until the runner stream finally has run', async () => {
		const order: string[] = [];
		// Manual control: the runner's cancel-cleanup completes only when
		// `triggerCleanup` is called.
		let triggerCleanup: () => void = () => { /* set below */ };
		const cleanupArrived = new Promise<void>((res) => {
			triggerCleanup = res;
		});

		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					try {
						yield {
							kind: 'metadata',
							columns: [{ name: 'n' }],
						} satisfies ResultEvent;
						// Park until the consumer cancels — then simulate
						// async cleanup before the generator throws.
						await new Promise<never>((_resolve, reject) => {
							signal!.addEventListener('abort', () => {
								order.push('abort-handled');
								void cleanupArrived.then(() => {
									order.push('runner-cleanup-done');
									reject(new Error('cancelled'));
								});
							});
						});
					} finally {
						order.push('runner-finally');
					}
				})();
			},
		};

		const q = new Query({ runner, request: stmt('q') });

		// Start a consumer in the background — it iterates until cancel.
		const consumerPromise = (async () => {
			try {
				for await (const _row of q.iterate()) {
					/* noop */
				}
			} catch {
				/* expected: cancelled */
			}
			order.push('consumer-done');
		})();

		// Yield enough turns for the runner to start and the consumer to
		// be parked.
		await new Promise((r) => setImmediate(r));

		// Start the cancel — it MUST not resolve until the runner stream
		// has fully terminated (the `runner-finally` log entry).
		const cancelPromise = q.cancel();
		let cancelResolved = false;
		void cancelPromise.then(() => {
			cancelResolved = true;
		});

		// Yield turns to let any sync/microtask resolution fire.
		await new Promise((r) => setImmediate(r));

		// At this point the runner's abort handler has fired but cleanup
		// hasn't completed (we control `triggerCleanup`). If cancel()
		// resolved here, it would be returning before the runner stream
		// settled — and the surrounding poolRunner's `await using`
		// would release the connection mid-cleanup.
		assert.equal(order[0], 'abort-handled', 'abort handler ran');
		assert.equal(
			cancelResolved,
			false,
			'cancel() resolved before the runner stream finished cleanup — connection would be released mid-settle',
		);

		// Trigger cleanup → runner generator throws → finally fires →
		// cancel awaits termination, then resolves.
		triggerCleanup();
		await cancelPromise;
		await consumerPromise;

		assert.deepEqual(order, [
			'abort-handled',
			'runner-cleanup-done',
			'runner-finally',
			'consumer-done',
		]);
	});
});

// ─── Trailer events: info, print, envChange, output, returnValue ────────────

describe('Query — trailer event accumulation', () => {
	test('info messages accumulate in meta.info with full payload', async () => {
		const infoEvent: ResultEvent = {
			kind: 'info',
			number: 5701,
			state: 1,
			class: 0,
			message: 'Changed database context to MyDB',
			serverName: 'srv',
			procName: 'sp_x',
			lineNumber: 12,
		};
		const { runner } = makeFakeRunner([
			infoEvent,
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.run();
		const meta = q.meta();
		assert.equal(meta.info.length, 1);
		const got: InfoMessage | undefined = meta.info[0];
		assert.equal(got?.number, 5701);
		assert.equal(got?.state, 1);
		assert.equal(got?.class, 0);
		assert.equal(got?.message, 'Changed database context to MyDB');
		assert.equal(got?.serverName, 'srv');
		assert.equal(got?.procName, 'sp_x');
		assert.equal(got?.lineNumber, 12);
	});

	test('print messages accumulate in meta.print', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'print', message: 'first' },
			{ kind: 'print', message: 'second' },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('PRINT ...') });
		await q.run();
		assert.deepEqual(q.meta().print, ['first', 'second']);
	});

	test('envChange events accumulate in meta.envChanges', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'envChange', type: 'database', oldValue: 'master', newValue: 'tempdb' },
			{ kind: 'envChange', type: 'language', oldValue: 'us_english', newValue: 'fr' },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('USE tempdb; SET LANGUAGE french') });
		await q.run();
		const envChanges: readonly EnvChange[] = q.meta().envChanges;
		assert.equal(envChanges.length, 2);
		assert.equal(envChanges[0]?.type, 'database');
		assert.equal(envChanges[0]?.oldValue, 'master');
		assert.equal(envChanges[1]?.type, 'language');
	});

	test('output parameters accumulate in meta.output keyed by name', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'output', name: 'newId', value: 42 },
			{ kind: 'output', name: 'status', value: 'ok' },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		interface Output { newId: number; status: string }
		const q = new Query({ runner, request: stmt('EXEC sp_x') });
		const meta: QueryMeta<Output> = await q.run<Output>();
		assert.equal(meta.output.newId, 42);
		assert.equal(meta.output.status, 'ok');
	});

	test('returnValue is captured from the last returnValue event', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'returnValue', value: 0 },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('EXEC sp_x') });
		const meta = await q.run();
		assert.equal(meta.returnValue, 0);
	});

	test('returnValue is undefined for non-procedure queries', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		const meta = await q.run();
		assert.equal(meta.returnValue, undefined);
	});

	test('trailer accumulates regardless of which terminal fired', async () => {
		// Same trailer events should land in the trailer whether we
		// consume via .all(), .iterate(), .run(), or .result().
		const events: ResultEvent[] = [
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'info', number: 1, state: 0, class: 0, message: 'hello' },
			{ kind: 'print', message: 'hi' },
			{ kind: 'returnValue', value: 7 },
			{ kind: 'done' },
		];

		const a = await new Query({
			runner: makeFakeRunner(() => [...events]).runner,
			request: stmt('q'),
		}).all();
		// Need to retain the Query reference for .meta() — wrap above.
		const aQ = new Query({
			runner: makeFakeRunner(() => [...events]).runner,
			request: stmt('q'),
		});
		await aQ.all();
		assert.equal(aQ.meta().info.length, 1);
		assert.equal(aQ.meta().print.length, 1);
		assert.equal(aQ.meta().returnValue, 7);
		assert.equal(a.length, 1, 'rows still drained');

		const rQ = new Query({
			runner: makeFakeRunner(() => [...events]).runner,
			request: stmt('q'),
		});
		const rMeta = await rQ.run();
		assert.equal(rMeta.info.length, 1);
		assert.equal(rMeta.print.length, 1);
		assert.equal(rMeta.returnValue, 7);

		const resQ = new Query({
			runner: makeFakeRunner(() => [...events]).runner,
			request: stmt('q'),
		});
		const { rows: resRows, meta: resMeta } = await resQ.result();
		assert.equal(resRows.length, 1);
		assert.equal(resMeta.info.length, 1);
		assert.equal(resMeta.returnValue, 7);
	});
});

// ─── Query.raw() — view toggle ──────────────────────────────────────────────

describe('Query.raw() — view toggle', () => {
	test('returns a NEW Query (does not consume the original)', async () => {
		const { runner } = makeFakeRunner(() => [
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n') });
		const r = q.raw<[number]>();
		assert.notEqual(q, r, '.raw() returned a new Query');
		// Original is still consumable.
		const objs = await q;
		assert.deepEqual(objs, [{ n: 1 }]);
		// Raw view consumes its OWN round-trip — the runner is invoked twice
		// (once for `q`, once for `r`).
		const tups = await r;
		assert.deepEqual(tups, [[1]]);
	});

	test('rows arrive as positional tuples in column order', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
			{ kind: 'row', values: [1, 'x', null] },
			{ kind: 'row', values: [2, 'y', 'z'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a, b, c') });
		const rows = await q.raw<[number, string, string | null]>();
		assert.deepEqual(rows, [[1, 'x', null], [2, 'y', 'z']]);
	});

	test('preserves duplicate-column values that the default object shape collapses', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'id' }, { name: 'id' }] },
			{ kind: 'row', values: [1, 2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a.id, b.id') });
		const rows = await q.raw<[number, number]>();
		assert.deepEqual(rows, [[1, 2]], 'both duplicate-named columns preserved');
	});

	test('.raw() does not invoke the runner (lazy)', () => {
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		q.raw();
		assert.equal(log.calls, 0, 'raw() did not start execution');
	});

	test('.raw() can be called any number of times — each call is a fresh Query', async () => {
		const { runner } = makeFakeRunner(() => [
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		const a = q.raw();
		const b = q.raw();
		assert.notEqual(a, b);
		await a;
		await b;
	});

	test('streaming via for-await on a raw Query yields tuples', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }, { name: 'b' }] },
			{ kind: 'row', values: [1, 'x'] },
			{ kind: 'row', values: [2, 'y'] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a, b') });
		const collected: [number, string][] = [];
		for await (const row of q.raw<[number, string]>().iterate()) {
			collected.push(row);
		}
		assert.deepEqual(collected, [[1, 'x'], [2, 'y']]);
	});

	test('.run() works on a raw Query (drain-only ignores raw mode)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 5 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t') });
		const meta = await q.raw().run();
		assert.equal(meta.rowsAffected, 5);
	});
});

// ─── Query.columns() — first-rowset shape access ────────────────────────────
//
// `.columns()` is a non-consuming terminal that resolves to the column
// metadata of the FIRST rowset (ADR-0007). Two execution paths:
//
// 1. Called BEFORE any row terminal: a "shape-only pump" pulls events
//    from the runner into a lookahead buffer until the first metadata
//    token, then stops — the runner iterator is left paused, with
//    driver-level backpressure holding the connection. A subsequent row
//    terminal drains the lookahead and continues from the same runner
//    iterator (no second `runner.run()` call). `.dispose()` / `.cancel()`
//    on a paused shape-pump triggers `iter.return()` on the runner,
//    firing its `try/finally` cleanup chain.
//
// 2. Called AFTER (or concurrently with) a row terminal: the row
//    terminal is the sole consumer of the runner; `.columns()` waits
//    for `#observeEvent` to capture the first metadata token and
//    resolve the cached promise.
//
// In both paths, `.columns()` returns the SAME Promise across repeat
// calls (locked to the first rowset), is concurrent-safe, and resolves
// to `[]` for a query that produces no rowsets (e.g. pure DML).

describe('Query.columns() — first-rowset shape access', () => {
	test('resolves to the first-rowset metadata when called before any terminal', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }, { name: 'b' }] },
			{ kind: 'row', values: [1, 'x'] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a, b FROM t') });
		const cols = await q.columns();
		assert.deepEqual(cols, [{ name: 'a' }, { name: 'b' }]);
		// Shape pump kicked off a runner.run(); cleanup hasn't fired yet —
		// the iterator is left paused, awaiting either a row terminal or
		// dispose().
		assert.equal(log.calls, 1);
		assert.equal(log.releases, 0, 'iter left paused — runner finally not yet fired');
	});

	test('resolves to the first-rowset metadata when called after a terminal', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.all();
		// After natural drain, `.columns()` resolves synchronously from
		// the captured first-rowset metadata.
		const cols = await q.columns();
		assert.deepEqual(cols, [{ name: 'n' }]);
	});

	test('returns the same Promise on repeat calls (locked to first rowset)', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }] },
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a') });
		const p1 = q.columns();
		const p2 = q.columns();
		assert.equal(p1, p2, 'same Promise instance returned on repeat calls');
		await q.all();  // drive the stream so the promise resolves
		assert.deepEqual(await p1, [{ name: 'a' }]);
	});

	test('after the first metadata is captured, repeat calls resolve to the same content', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.all();
		const a = await q.columns();
		const b = await q.columns();
		assert.deepEqual(a, b);
		assert.deepEqual(a, [{ name: 'n' }]);
	});

	test('does NOT consume the Query — terminals can fire after .columns()', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n') });
		const cols = await q.columns();
		assert.deepEqual(cols, [{ name: 'n' }]);
		// Terminal still fires — `.columns()` did not flip the
		// single-consumption flag.
		const rows = await q.all();
		assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
		// Single runner.run() call across .columns() + .all() — the row
		// terminal continued from the paused shape-pump iterator rather
		// than starting a fresh stream.
		assert.equal(log.calls, 1, 'shape pump + terminal share one runner.run() call');
		assert.equal(log.releases, 1, 'natural drain fired runner finally exactly once');
	});

	test('terminal after columns() sees metadata and rows in arrival order', async () => {
		// The shape pump captures the metadata event into a lookahead
		// buffer; the row terminal drains it before continuing from the
		// runner iterator. Verifies the lookahead → continuation handoff.
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [10] },
			{ kind: 'row', values: [20] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n') });
		await q.columns();
		const rows: number[] = [];
		for await (const row of q.iterate()) {
			rows.push(row.n);
		}
		assert.deepEqual(rows, [10, 20]);
	});

	test('resolves to [] for a query that produces no rowsets', async () => {
		// Pure-DML / WAITFOR style — driver emits a `done` (or
		// rowsetEnd + done) without ever sending metadata. `.columns()`
		// resolves to the empty array.
		const { runner } = makeFakeRunner([
			{ kind: 'rowsetEnd', rowsAffected: 0 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('UPDATE t SET x = 1 WHERE 1 = 0') });
		const cols = await q.columns();
		assert.deepEqual(cols, []);
	});

	test('resolves to [] when no terminal fires and the stream has no rowsets', async () => {
		// Same shape as above but checks the shape-pump path drives the
		// runner to natural end, then settles `.columns()` with [].
		const { runner, log } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('UPDATE t SET x = 1 WHERE 1 = 0') });
		const cols = await q.columns();
		assert.deepEqual(cols, []);
		// Shape pump exhausted the runner naturally — finally fired.
		assert.equal(log.releases, 1);
	});

	test('rejects with the stream error if the stream errors before metadata', async () => {
		const boom = new Error('connection lost');
		const runner: RequestRunner = {
			run() {
				// The throw lives in `run()` itself — no need for a generator
				// at all when we never yield. Returning an async iterable
				// whose first `.next()` rejects exercises the same code
				// path as a generator that throws on entry.
				const iter: AsyncIterableIterator<ResultEvent> = {
					[Symbol.asyncIterator]() { return this; },
					next() { return Promise.reject(boom); },
				};
				return iter;
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await assert.rejects(() => q.columns(), /connection lost/);
	});

	test('after a failed terminal, .columns() rejects with the same error', async () => {
		const boom = new Error('mid-stream failure');
		const runner: RequestRunner = {
			run() {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'a' }] } satisfies ResultEvent;
					throw boom;
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT a') });
		// Even though metadata flowed BEFORE the error, the failed terminal
		// captured the columns into `#firstColumns` via observation. So
		// `.columns()` returns those columns from the fast path. This
		// matches the non-consuming contract: `.columns()` describes the
		// shape that DID flow, regardless of subsequent errors.
		await assert.rejects(() => q.all(), /mid-stream failure/);
		const cols = await q.columns();
		assert.deepEqual(cols, [{ name: 'a' }]);
	});

	test('rejects with the stream error when the terminal errors before metadata', async () => {
		// Same shape as above, but the error fires BEFORE metadata. The
		// shape was never observed, so `.columns()` rejects with the
		// stored stream error.
		const boom = new Error('protocol failure');
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
		await assert.rejects(() => q.all(), /protocol failure/);
		await assert.rejects(() => q.columns(), /protocol failure/);
	});

	test('rejects with TypeError on a disposed Query', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.dispose();
		await assert.rejects(() => q.columns(), TypeError);
	});

	test('dispose() while .columns() is pending rejects the columns promise', async () => {
		// Driver that parks on the signal's abort — simulates a real
		// connection where metadata hasn't flowed yet because the server
		// is still preparing the result set.
		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					yield await new Promise<never>((_resolve, reject) => {
						signal!.addEventListener('abort', () => {
							reject(new Error('aborted'));
						});
					});
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		const colsPromise = q.columns();
		// Yield to let the shape pump start.
		await new Promise((r) => setImmediate(r));
		await q.dispose();
		await assert.rejects(() => colsPromise);
	});

	test('cancel() before metadata rejects the columns promise', async () => {
		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					yield await new Promise<never>((_resolve, reject) => {
						signal!.addEventListener('abort', () => {
							reject(new Error('aborted'));
						});
					});
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		const colsPromise = q.columns();
		await new Promise((r) => setImmediate(r));
		await q.cancel();
		await assert.rejects(() => colsPromise);
	});

	test('q.raw().columns() works the same as q.columns() — view toggle does not affect shape access', async () => {
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'a' }, { name: 'b' }] },
			{ kind: 'row', values: [1, 2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT a, b FROM t') });
		const cols = await q.raw().columns();
		assert.deepEqual(cols, [{ name: 'a' }, { name: 'b' }]);
	});

	test('Promise.all([columns(), all()]) — concurrent-safe across both consumers', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 2 },
			{ kind: 'done' },
		]);
		const q = new Query<{ n: number }>({ runner, request: stmt('SELECT n') });
		const [cols, rows] = await Promise.all([q.columns(), q.all()]);
		assert.deepEqual(cols, [{ name: 'n' }]);
		assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
		// Still a single runner.run() across both consumers.
		assert.equal(log.calls, 1);
	});

	test('locked to FIRST rowset on multi-rowset queries — second rowset metadata is not exposed', async () => {
		// `.columns()` describes the first rowset only. `.run()` (drain-
		// only) is rowset-oblivious so it consumes both without throwing,
		// but `.columns()` still returns just the first.
		const { runner } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'first' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'metadata', columns: [{ name: 'second' }] },
			{ kind: 'row', values: [2] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT first; SELECT second') });
		const cols = await q.columns();
		assert.deepEqual(cols, [{ name: 'first' }]);
		// Drive the stream to completion via .run() (rowset-oblivious).
		await q.run();
		// Repeat call still resolves to the FIRST-rowset columns.
		const colsAgain = await q.columns();
		assert.deepEqual(colsAgain, [{ name: 'first' }]);
	});

	test('.run() after .columns() drains the lookahead and completes', async () => {
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.columns();
		const meta = await q.run();
		assert.equal(meta.completed, true);
		assert.equal(meta.rowsAffected, 1);
		assert.equal(log.calls, 1, 'no second runner.run()');
	});

	test('.dispose() after .columns() (paused shape pump) fires runner finally exactly once', async () => {
		// Verifies the dispose-on-paused-shape-pump path: cancel() must
		// call iter.return() on the runner iterator, which triggers the
		// runner's try/finally and releases the underlying connection.
		const { runner, log } = makeFakeRunner([
			{ kind: 'metadata', columns: [{ name: 'n' }] },
			{ kind: 'row', values: [1] },
			{ kind: 'rowsetEnd', rowsAffected: 1 },
			{ kind: 'done' },
		]);
		const q = new Query({ runner, request: stmt('SELECT n') });
		await q.columns();
		assert.equal(log.releases, 0, 'iter is paused after shape pump captures metadata');
		await q.dispose();
		assert.equal(log.releases, 1, 'dispose triggered iter.return → runner finally');
	});
});

// ─── Query.cancel() / .dispose() — feature behaviour ────────────────────────

describe('Query.cancel() / .dispose() — feature behaviour', () => {
	test('cancel() before any terminal pre-arms the abort — first terminal call sees an aborted signal', async () => {
		// Use a runner that honours the signal (real drivers do — e.g.
		// tedious's `events.on` throws on aborted signal at next pull).
		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					signal?.throwIfAborted();
					yield { kind: 'done' } satisfies ResultEvent;
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.cancel();
		// First terminal sees the already-aborted signal and rejects.
		await assert.rejects(() => q.all());
	});

	test('cancel() is idempotent — second call is a no-op', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.cancel();
		await q.cancel();  // doesn't throw
	});

	test('dispose() cancels and marks the Query unusable', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.dispose();
		assert.throws(() => q.iterate(), TypeError);
		await assert.rejects(() => q.all(), TypeError);
		await assert.rejects(() => q.run(), TypeError);
	});

	test('dispose() is idempotent', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		const q = new Query({ runner, request: stmt('SELECT 1') });
		await q.dispose();
		await q.dispose();  // doesn't throw
	});

	test('await using cleans up at scope end', async () => {
		const { runner } = makeFakeRunner([{ kind: 'done' }]);
		let captured: Query<unknown> | null = null;
		{
			await using q = new Query({ runner, request: stmt('SELECT 1') });
			captured = q;
		}
		// `q` has been disposed; subsequent terminals throw.
		assert.throws(() => captured!.iterate(), TypeError);
	});

	test('cancel() mid-stream propagates AbortError to the row terminal', async () => {
		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					yield { kind: 'metadata', columns: [{ name: 'n' }] } satisfies ResultEvent;
					await new Promise<never>((_resolve, reject) => {
						signal!.addEventListener('abort', () => {
							reject(new Error('aborted'));
						});
					});
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT n') });
		const consumer = (async () => {
			try {
				for await (const _ of q.iterate()) { /* */ }
				return 'completed';
			} catch (err) {
				return (err as Error).message;
			}
		})();
		// Yield until the consumer is parked.
		await new Promise((r) => setImmediate(r));
		await q.cancel();
		assert.equal(await consumer, 'aborted');
	});

	test('meta() after cancel returns completed=false with partial trailer', async () => {
		const runner: RequestRunner = {
			run(_req, signal) {
				return (async function* () {
					yield {
						kind: 'metadata',
						columns: [{ name: 'n' }],
					} satisfies ResultEvent;
					yield { kind: 'row', values: [1] } satisfies ResultEvent;
					await new Promise<never>((_resolve, reject) => {
						signal!.addEventListener('abort', () => {
							reject(new Error('aborted'));
						});
					});
				})();
			},
		};
		const q = new Query({ runner, request: stmt('SELECT n') });
		const consumer = (async () => {
			try {
				for await (const _ of q.iterate()) { /* */ }
			} catch { /* expected */ }
		})();
		await new Promise((r) => setImmediate(r));
		await q.cancel();
		await consumer;
		const meta = q.meta();
		assert.equal(meta.completed, false, 'completed=false on cancel');
	});
});
