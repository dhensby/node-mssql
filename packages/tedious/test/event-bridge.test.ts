import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import type { Request as TediousRequest } from 'tedious';
import type { ResultEvent } from '@tediousjs/mssql-core';
import { EventBridge } from '../src/event-bridge.js';

// ─── Fake tedious Request ───────────────────────────────────────────────────
//
// Exposes the same listener-attach surface as a real `tedious.Request`
// for the events the bridge cares about, plus `pause` / `resume` /
// `cancel` / `removeAllListeners`. Tests drive it by calling its
// `fire<EventName>` helpers, which emit the equivalent tedious events
// at the bridge.

class FakeRequest extends EventEmitter {
	paused = 0;
	resumed = 0;
	cancelled = 0;
	listenersRemoved = 0;

	pause(): void { this.paused++; }
	resume(): void { this.resumed++; }

	// Mirror tedious: cancel() initiates a cancel attention; the server
	// responds asynchronously and tedious emits requestCompleted on the
	// Request. Tests that need to control timing override this method;
	// the default below uses `queueMicrotask` so the cancel-ack lands
	// "next tick" — fast enough for synchronous-looking tests but still
	// async (matching real tedious behaviour).
	cancel(): void {
		this.cancelled++;
		queueMicrotask(() => this.emit('requestCompleted'));
	}

	override removeAllListeners(): this {
		this.listenersRemoved++;
		return super.removeAllListeners();
	}

	// Helpers for tests — emit the tedious-side events the bridge listens for.
	fireMetadata(cols: { colName: string }[]): void {
		this.emit('columnMetadata', cols);
	}
	fireRow(values: unknown[]): void {
		this.emit('row', values.map((value) => ({ value })));
	}
	fireDone(rowCount: number | undefined = 0): void {
		this.emit('done', rowCount);
	}
	fireDoneInProc(rowCount: number | undefined = 0): void {
		this.emit('doneInProc', rowCount);
	}
	fireError(err: Error): void {
		this.emit('error', err);
	}
	fireRequestCompleted(): void {
		this.emit('requestCompleted');
	}
}

const buildBridge = (): { bridge: EventBridge; request: FakeRequest } => {
	const request = new FakeRequest();
	// Cast — the bridge only uses methods that FakeRequest mirrors. The
	// constructor takes `Request`; we substitute a structurally-compatible
	// fake so tests don't need a real connection.
	const bridge = new EventBridge(request as unknown as TediousRequest);
	return { bridge, request };
};

const collect = async (
	iter: AsyncIterableIterator<[ResultEvent]>,
): Promise<ResultEvent[]> => {
	const out: ResultEvent[] = [];
	for await (const [ev] of iter) {
		out.push(ev);
	}
	return out;
};

// ─── Translation: tedious events → ResultEvent ──────────────────────────────

describe('EventBridge — tedious event translation', () => {
	test('columnMetadata with array form → metadata ResultEvent', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'id' }, { colName: 'name' }]);
		request.fireDone(0);
		request.fireRequestCompleted();

		const events = await collect(iter);
		assert.equal(events.length, 2);
		assert.deepEqual(events[0], { kind: 'metadata', columns: [{ name: 'id' }, { name: 'name' }] });
	});

	test('columnMetadata with non-array (keyed-object) shape is defensively dropped', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		// Keyed-object form (default-off useColumnNames) — bridge ignores.
		(request as unknown as { emit: (e: string, p: unknown) => boolean }).emit(
			'columnMetadata',
			{ id: { colName: 'id' } },
		);
		request.fireRequestCompleted();
		const events = await collect(iter);
		assert.equal(events.length, 0);
	});

	test('row → row ResultEvent with values extracted from {value}', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'n' }]);
		request.fireRow([42]);
		request.fireRow(['hello']);
		request.fireDone(2);
		request.fireRequestCompleted();

		const events = await collect(iter);
		const rows = events.filter((e) => e.kind === 'row');
		assert.deepEqual(rows.map((r) => r.values), [[42], ['hello']]);
	});

	test('done → rowsetEnd with rowsAffected', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireDone(7);
		request.fireRequestCompleted();
		const events = await collect(iter);
		assert.deepEqual(events, [{ kind: 'rowsetEnd', rowsAffected: 7 }]);
	});

	test('doneInProc → rowsetEnd (sql-batch sometimes routes through stored-proc path)', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireDoneInProc(3);
		request.fireRequestCompleted();
		const events = await collect(iter);
		assert.deepEqual(events, [{ kind: 'rowsetEnd', rowsAffected: 3 }]);
	});

	test('done with undefined rowCount → rowsetEnd with 0', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireDone(undefined);
		request.fireRequestCompleted();
		const events = await collect(iter);
		assert.deepEqual(events, [{ kind: 'rowsetEnd', rowsAffected: 0 }]);
	});
});

// ─── Lifecycle: end / error termination ─────────────────────────────────────

describe('EventBridge — termination', () => {
	test('requestCompleted → bridge `end` → events.on iterator naturally ends', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'x' }]);
		request.fireRow([1]);
		request.fireDone(1);
		request.fireRequestCompleted();

		const events = await collect(iter);
		assert.equal(events.length, 3);
	});

	test('request error → events.on iterator throws', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireError(new Error('connection lost'));
		await assert.rejects(() => collect(iter), /connection lost/);
	});

	test('events buffered before error are still yielded before the throw', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'n' }]);
		request.fireRow([1]);
		request.fireError(new Error('mid-stream failure'));

		const seen: ResultEvent[] = [];
		await assert.rejects(async () => {
			for await (const [ev] of iter) {
				seen.push(ev);
			}
		}, /mid-stream failure/);
		assert.equal(seen.length, 2, 'buffered events drained before throw');
	});
});

// ─── Backpressure ──────────────────────────────────────────────────────────

describe('EventBridge — backpressure', () => {
	test('pause() / resume() forward to the underlying request', () => {
		const { bridge, request } = buildBridge();
		bridge.pause();
		bridge.pause();
		bridge.resume();
		assert.equal(request.paused, 2);
		assert.equal(request.resumed, 1);
	});

	test('events.on watermark triggers pause; consumer drain triggers resume', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', {
			highWaterMark: 3,
			close: ['end'],
		}) as AsyncIterableIterator<[ResultEvent]>;

		// Fire 10 rows with no consumer pull yet → backpressure should kick
		// in once the buffer hits 3.
		request.fireMetadata([{ colName: 'n' }]);
		for (let i = 0; i < 10; i++) {
			request.fireRow([i]);
		}
		request.fireDone(10);
		request.fireRequestCompleted();

		assert.ok(request.paused >= 1, 'pause was called once watermark hit');

		// Consume — should drain and yield resume at some point.
		const events = await collect(iter);
		assert.equal(events.filter((e) => e.kind === 'row').length, 10);
		assert.ok(request.resumed >= 1, 'resume was called as the consumer drained');
	});
});

// ─── Cancel-then-release ordering (regression for cancel-mid-response leak) ──
//
// The bug guarded against here: tedious's `request.cancel()` initiates a
// cancel attention to the server but doesn't wait for the cancel-ack. If
// `bridge.destroy()` returns before the ack arrives, the surrounding
// poolRunner's `await using pooled` releases the connection back to the
// pool while tedious is still mid-cancel-response. The pool's
// `Connection.reset()` then runs on top of an unsettled cancel, leaving
// the connection in a state the next acquire can't safely use.
//
// `destroy()` MUST await `'requestCompleted'` (which the bridge surfaces
// as `'end'`) before resolving, so the connection only returns to the
// pool once tedious has fully settled the request.

describe('EventBridge — cancel-then-settle ordering (regression)', () => {
	test('destroy() does not resolve until requestCompleted has fired on the underlying Request', async () => {
		const { bridge, request } = buildBridge();

		// Replace cancel() with a controllable simulator: the cancel-ack
		// arrives only when we call `triggerAck()`, mirroring tedious's
		// real behaviour where the response is a server round-trip.
		let triggerAck: () => void = () => { /* set by ackArrived */ };
		const ackArrived = new Promise<void>((resolve) => { triggerAck = resolve; });
		request.cancel = function() {
			this.cancelled++;
			void ackArrived.then(() => this.emit('requestCompleted'));
		};

		// Track resolution state on the destroy promise without awaiting
		// yet. `Promise.resolve(value)` passes Promises through unchanged
		// and wraps non-Promises — works for both the buggy sync `destroy()`
		// (returns void) and the fixed async one.
		const destroyPromise = Promise.resolve(bridge.destroy());
		let destroyResolved = false;
		void destroyPromise.then(() => { destroyResolved = true; });

		// Yield enough to let any synchronous / microtask resolution land.
		// `setImmediate` runs after all queued microtasks for this turn
		// (and after any setTimeout(0) that's already been queued).
		await new Promise((r) => setImmediate(r));

		// Without the await-settle fix, destroy returned synchronously
		// (it just initiated cancel + removed listeners), so destroyResolved
		// is already true at this point. With the fix, destroy is parked
		// awaiting `'end'` which fires from requestCompleted — and we
		// haven't triggered the ack yet, so destroy is still pending.
		assert.equal(
			destroyResolved,
			false,
			'destroy() resolved before requestCompleted fired — pool would release a connection mid-cancel-response',
		);

		// Trigger the cancel-ack. After the fix, this lets destroy resolve.
		triggerAck();
		await destroyPromise;
	});

	test('destroy() returns immediately when requestCompleted has already fired (no hang on the no-cancel-needed path)', async () => {
		const { bridge, request } = buildBridge();
		// Stream completed naturally before destroy is called.
		request.fireDone(0);
		request.fireRequestCompleted();
		// Should resolve without needing another `requestCompleted`.
		await Promise.race([
			Promise.resolve(bridge.destroy()),
			new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100)),
		]);
	});
});

describe('EventBridge — destroy', () => {
	test('destroy() cancels the underlying request and removes its listeners', async () => {
		const { bridge, request } = buildBridge();
		// FakeRequest's default `cancel()` simulates tedious by firing
		// `requestCompleted` on the next microtask, so destroy resolves
		// without manual orchestration.
		await bridge.destroy();
		assert.equal(request.cancelled, 1);
		assert.equal(request.listenersRemoved, 1);
	});

	test('destroy() is safe to call after natural completion (skips the cancel-then-await fast path)', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireDone(0);
		request.fireRequestCompleted();
		await collect(iter);
		await bridge.destroy();
		// Already-completed path: cancel is NOT called because the request
		// has already settled. Listener cleanup still runs.
		assert.equal(request.cancelled, 0, 'cancel skipped on already-completed path');
		assert.equal(request.listenersRemoved, 1);
	});

	test('destroy() is idempotent — repeat calls return the same Promise', async () => {
		const { bridge } = buildBridge();
		const a = bridge.destroy();
		const b = bridge.destroy();
		assert.equal(a, b, 'second destroy() returned the stored promise');
		await a;
	});
});

// ─── Crash safety: 'error' emits after listener cleanup ─────────────────────
//
// Node's EventEmitter throws on `emit('error', ...)` when no listeners
// are attached for `'error'`. Two cleanup windows can land us there if
// we're not careful — both pinned with regression tests:

describe('EventBridge — crash-safety on post-cleanup error emits', () => {
	test('bridge has a default `error` listener — re-emits during the cleanup window do not crash', async () => {
		// Repro the events.on-cleanup window: pull events.on's iterator,
		// then simulate consumer break (iter.return()), THEN have tedious
		// emit `error` on the underlying Request. Without the bridge's
		// default `error` listener, the bridge's re-emit would crash.
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'n' }]);
		await iter.next();
		await iter.return?.(undefined);

		// At this point events.on has removed its listeners on the
		// bridge but the bridge's listeners on `request` are still
		// attached (destroy() hasn't run yet). Firing `error` on
		// `request` re-emits on the bridge — only the bridge's default
		// noop catches it.
		assert.doesNotThrow(() => {
			request.fireError(new Error('post-cleanup error'));
		});
	});

	test('destroy() leaves a noop `error` listener on the Request — post-cancel errors from tedious do not crash', async () => {
		// Repro the post-destroy window: after destroy() resolves, the
		// Request's listeners are removed and the noop `error` listener
		// is in place. Tedious might still fire `error` asynchronously.
		const { bridge, request } = buildBridge();
		await bridge.destroy();
		// Without the noop listener that destroy() re-attaches, this
		// fireError would crash because the Request has no `error`
		// listeners.
		assert.doesNotThrow(() => {
			request.fireError(new Error('post-cancel error'));
		});
	});
});

// ─── AbortSignal integration ────────────────────────────────────────────────

describe('EventBridge — AbortSignal via events.on', () => {
	test('events.on throws synchronously when given an already-aborted signal', () => {
		const { bridge } = buildBridge();
		const ac = new AbortController();
		ac.abort(new Error('caller cancelled'));
		// `events.on()` checks the signal eagerly — already-aborted means
		// the call itself throws, before the iterator ever yields.
		assert.throws(() =>
			on(bridge, 'data', { signal: ac.signal, close: ['end'] }),
		);
	});

	test('signal aborted while iterator is awaiting throws on that pull', async () => {
		const { bridge, request } = buildBridge();
		const ac = new AbortController();
		const iter = on(bridge, 'data', {
			signal: ac.signal,
			close: ['end'],
		}) as AsyncIterableIterator<[ResultEvent]>;
		request.fireMetadata([{ colName: 'n' }]);
		// Drain the only buffered event. The iterator is now awaiting
		// more events.
		const first = await iter.next();
		assert.equal(first.done, false);
		// Pending pull — iterator is parked waiting for the next event.
		const pending = iter.next();
		ac.abort(new Error('mid-stream cancel'));
		await assert.rejects(() => pending);
	});
});
