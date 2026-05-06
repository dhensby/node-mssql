/**
 * Bridge between tedious's event-emitter `Request` and core's
 * `AsyncIterable<ResultEvent>` Connection.execute() contract.
 *
 * The bridge is itself a typed `EventEmitter` — Node's `events.on()`
 * handles the queue, backpressure, and AbortSignal wiring for us, so
 * we don't hand-roll a producer-consumer queue. Translation from
 * tedious's event shape to core's `ResultEvent` happens in this class;
 * everything else (iteration, watermarks, signal abort) is built-in.
 *
 * Backpressure model: `events.on(bridge, 'data', { highWaterMark })`
 * calls `bridge.pause()` when its internal buffer fills and
 * `bridge.resume()` when it drains. We forward those to
 * `request.pause()` / `request.resume()`, which pause / resume reads
 * off the wire at the tedious layer.
 *
 * Iteration ends naturally when the bridge emits `'end'` (we wire that
 * to tedious's `requestCompleted` event) — the consumer side passes
 * `close: ['end']` to `events.on()` to opt in.
 *
 * Errors emitted on the bridge propagate as iterator throws; events
 * queued before the error still drain first (Node's `events.on()`
 * contract).
 *
 * Internal helper — not part of the public surface of
 * `@tediousjs/mssql-tedious`.
 */

import { EventEmitter } from 'node:events';
import type { ColumnMetadata, ResultEvent } from '@tediousjs/mssql-core';
import type { Request } from 'tedious';

export interface BridgeEvents {
	data: [ResultEvent]
	error: [Error]
	end: []
}

export class EventBridge extends EventEmitter<BridgeEvents> {
	readonly #request: Request;

	constructor(request: Request) {
		super();
		this.#request = request;

		// Default `error` listener — Node's EventEmitter throws on
		// `emit('error')` when no listeners are attached. There's a
		// micro-window between `events.on()`'s consumer-break cleanup
		// (which removes its listeners) and our `destroy()` call (which
		// removes the bridge's listeners on the underlying Request). If
		// tedious fires `'error'` in that window, our Request listener
		// re-emits on the bridge, which would otherwise crash the process.
		// This noop is the safety net. Errors that matter to the consumer
		// are still delivered to events.on's listener during normal
		// iteration — that listener fires alongside this one — so the
		// noop doesn't swallow anything the user can observe.
		this.on('error', () => { /* swallow post-cleanup errors */ });

		// columnMetadata: emit a metadata ResultEvent. Default
		// `useColumnNames: false` gives the array form; we defend against
		// the keyed-object shape just in case the option ever flips.
		request.on('columnMetadata', (cols) => {
			if (!Array.isArray(cols)) return;
			const columns: ColumnMetadata[] = cols.map((c) => ({ name: c.colName }));
			this.emit('data', { kind: 'metadata', columns });
		});

		// row: each entry is `{ metadata, value }` under the default
		// option. Tedious types this listener as `any` because the shape
		// varies with `useColumnNames`.
		request.on('row', (row: { value: unknown }[] | unknown) => {
			if (!Array.isArray(row)) return;
			const values: unknown[] = row.map((c) => c.value);
			this.emit('data', { kind: 'row', values });
		});

		// `done` (sql-batch path) and `doneInProc` (statement-in-procedure
		// path) both mark a rowset boundary. tedious docs note `execSql`
		// may sometimes emit `doneInProc` instead of `done`, so we listen
		// for both. `doneProc` (procedure end) intentionally not handled
		// — it isn't a rowset boundary.
		const onRowsetEnd = (rowCount: number | undefined): void => {
			this.emit('data', { kind: 'rowsetEnd', rowsAffected: rowCount ?? 0 });
		};
		request.on('done', onRowsetEnd);
		request.on('doneInProc', onRowsetEnd);

		// Per-request error → iterator throw. `events.on()` flushes
		// buffered `'data'` events before propagating the throw, matching
		// the contract our V-3 hand-rolled bridge originally documented.
		request.on('error', (err: Error) => {
			this.emit('error', err);
		});

		// Tedious's `requestCompleted` is the natural-end signal — fires
		// after the last `done` / `doneInProc` regardless of success or
		// failure. Map to `'end'`; consumers of this bridge pass
		// `close: ['end']` to `events.on()` to terminate iteration.
		request.on('requestCompleted', () => {
			this.emit('end');
		});
	}

	// `events.on()` calls these on the emitter when its internal buffer
	// hits the high / low watermarks. We forward to the underlying
	// `Request`, which pauses / resumes reads off the wire.
	pause(): void {
		this.#request.pause();
	}

	resume(): void {
		this.#request.resume();
	}

	// Cancel the in-flight request and detach our listeners. Called on
	// every abnormal exit from the iterator (consumer break,
	// signal abort) by the wrapper generator in `connection.ts`.
	// Tedious's `cancel()` is a no-op when no request is in-flight,
	// so calling after natural completion is safe.
	destroy(): void {
		this.#request.cancel();
		this.#request.removeAllListeners();
		// Noop `error` listener so any post-cancel error tedious emits
		// asynchronously (e.g. as the cancel response arrives) doesn't
		// crash the process via the Request's own EventEmitter — same
		// "no listeners on `'error'` throws" hazard, just on the Request
		// side rather than the Bridge side.
		this.#request.on('error', () => { /* swallow post-cancel errors */ });
	}
}
