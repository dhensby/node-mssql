/**
 * `TediousConnectionWrapper` — implements core's `Connection` driver
 * port (ADR-0010) on top of a `tedious.Connection`.
 *
 * Vertical-slice cut (V-3): execute / close / reset / ping. Transaction
 * methods (`beginTransaction` / `commit` / `rollback` / `savepoint` /
 * `rollbackToSavepoint`) and `prepare` / `bulkLoad` throw
 * "not yet implemented" stubs and land in round-out commits.
 *
 * The `close` / `error` Connection-port events are also deferred —
 * tedious's `Connection.'end'` / `'error'` are connection-level signals
 * we'll translate to `Connection.close({reason})` in a round-out
 * commit. V-3 doesn't need them for the SELECT 1 path.
 */

import { EventEmitter, on, once } from 'node:events';
import { Request as TediousRequest, type Connection as TediousConnection } from 'tedious';
import type {
	Connection,
	ConnectionEvents,
	ExecuteRequest,
	ResultEvent,
} from '@tediousjs/mssql-core';
import { EventBridge } from './event-bridge.js';
import { inferParameterType } from './parameter-types.js';

const NOT_IMPLEMENTED = (method: string): Error =>
	new Error(
		`@tediousjs/mssql-tedious: ${method}() is not yet implemented. ` +
			`The vertical slice (V-3) lands execute / close / reset / ping; ` +
			`transactions, prepared statements, and bulk-load arrive in round-out commits.`,
	);

// Internal buffer size for events.on() — events accumulate up to this
// count before backpressure kicks in (bridge.pause() → request.pause()).
// 25 is generous for typical row sizes; round-out can tune per-driver
// when real-workload traces are available.
const EXECUTE_HIGH_WATER_MARK = 25;

export class TediousConnectionWrapper
	extends EventEmitter<ConnectionEvents>
	implements Connection
{
	readonly id: string;
	readonly #conn: TediousConnection;
	#closed = false;

	constructor(conn: TediousConnection, id: string) {
		super();
		this.#conn = conn;
		this.id = id;
	}

	execute(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
		const conn = this.#conn;

		const request = new TediousRequest(req.sql, () => {
			// Intentional no-op. Tedious also emits `requestCompleted` on
			// completion (success or failure); the bridge listens to that
			// to drive the `'end'` event. Having one signal — not two —
			// keeps the bridge's contract simple.
		});
		const bridge = new EventBridge(request);

		// Bind parameters — vertical-slice inference (parameter-types.ts).
		// Round-out replaces this with the SqlType<T> system from ADR-0019.
		const params = req.params ?? [];
		for (let i = 0; i < params.length; i++) {
			const p = params[i];
			if (p === undefined) continue;
			const name = p.name ?? `p${i}`;
			const inferred = inferParameterType(p.value);
			request.addParameter(name, inferred.type, inferred.value);
		}

		conn.execSql(request);

		// `events.on` handles the queue, backpressure (via the bridge's
		// `pause` / `resume`), the AbortSignal, and natural termination
		// on `'end'` (via `close: ['end']`). All we add is a wrapper
		// generator that calls `bridge.destroy()` in `finally` to cancel
		// the in-flight tedious request on abnormal exit (consumer break,
		// signal abort, downstream throw). On natural drain `destroy()`
		// is a no-op — tedious's `cancel()` after completion does
		// nothing.
		//
		// `events.on()` itself is constructed inside the generator so
		// that a sync throw from an already-aborted signal becomes a
		// rejection of the iterator's first `next()` rather than a sync
		// throw from `execute()` — keeping this method's contract as
		// "always returns an `AsyncIterable<ResultEvent>`".
		const onOptions: Parameters<typeof on>[2] = {
			highWaterMark: EXECUTE_HIGH_WATER_MARK,
			close: ['end'],
		};
		if (signal !== undefined) onOptions.signal = signal;
		return (async function* (): AsyncIterable<ResultEvent> {
			try {
				for await (
					const [event] of on(bridge, 'data', onOptions) as AsyncIterableIterator<[ResultEvent]>
				) {
					yield event;
				}
			} finally {
				bridge.destroy();
			}
		})();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// `once(emitter, 'end')` resolves when tedious's connection-level
		// 'end' event fires. We register the listener BEFORE calling
		// `close()` so we don't miss a synchronous emit.
		const ended = once(this.#conn, 'end').then(() => undefined);
		this.#conn.close();
		return ended;
	}

	async reset(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.#conn.reset((err) => {
				if (err !== undefined && err !== null) reject(err);
				else resolve();
			});
		});
	}

	async ping(): Promise<void> {
		// Smallest valid round-trip. Round-out can switch to a TDS-level
		// keepalive when one is available cheaply; for now `SELECT 1`
		// is the portable answer.
		await new Promise<void>((resolve, reject) => {
			const request = new TediousRequest('SELECT 1', (err) => {
				if (err !== undefined && err !== null) reject(err);
				else resolve();
			});
			this.#conn.execSql(request);
		});
	}

	async beginTransaction(): Promise<void> {
		throw NOT_IMPLEMENTED('beginTransaction');
	}
	async commit(): Promise<void> {
		throw NOT_IMPLEMENTED('commit');
	}
	async rollback(): Promise<void> {
		throw NOT_IMPLEMENTED('rollback');
	}
	async savepoint(): Promise<void> {
		throw NOT_IMPLEMENTED('savepoint');
	}
	async rollbackToSavepoint(): Promise<void> {
		throw NOT_IMPLEMENTED('rollbackToSavepoint');
	}
	async prepare(): Promise<{ id: string }> {
		throw NOT_IMPLEMENTED('prepare');
	}
	async bulkLoad(): Promise<{ rowsAffected: number }> {
		throw NOT_IMPLEMENTED('bulkLoad');
	}
}
