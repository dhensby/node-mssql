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
	cancel(): void { this.cancelled++; }

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

// ─── Cancellation ──────────────────────────────────────────────────────────

describe('EventBridge — destroy', () => {
	test('destroy() cancels the underlying request and removes its listeners', () => {
		const { bridge, request } = buildBridge();
		bridge.destroy();
		assert.equal(request.cancelled, 1);
		assert.equal(request.listenersRemoved, 1);
	});

	test('destroy() is safe to call after natural completion (cancel is a no-op)', async () => {
		const { bridge, request } = buildBridge();
		const iter = on(bridge, 'data', { close: ['end'] }) as AsyncIterableIterator<[ResultEvent]>;
		request.fireDone(0);
		request.fireRequestCompleted();
		await collect(iter);
		bridge.destroy();
		// FakeRequest counts every cancel call; tedious treats post-completion
		// cancel as a no-op. We just verify the call doesn't throw.
		assert.equal(request.cancelled, 1);
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

	test('destroy() leaves a noop `error` listener on the Request — post-cancel errors from tedious do not crash', () => {
		// Repro the post-destroy window: after destroy(), the Request's
		// listeners are removed. Tedious might still fire `error`
		// asynchronously as the cancel response arrives.
		const { bridge, request } = buildBridge();
		bridge.destroy();
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
