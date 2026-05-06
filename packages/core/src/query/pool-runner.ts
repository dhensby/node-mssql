/**
 * `poolRunner(pool)` — `RequestRunner` over a {@link Pool} (ADR-0023).
 *
 * The pool-bound runner: every `run()` call performs `pool.acquire()` →
 * `connection.execute()` → release-on-stream-end. Release is wired
 * through `await using` (ADR-0008's disposal contract — `PooledConnection`
 * implements `Symbol.asyncDispose` calling `release()`) so it fires on
 * every exit path — natural drain, mid-stream error, consumer break
 * (`iter.return()`), or signal-driven abort.
 *
 * Internal: the Client constructs one `poolRunner` per pool instance and
 * binds it into the user-facing `sql` tag. Users never call this directly.
 */

import type { Pool } from '../pool/index.js';
import type { ExecuteRequest, ResultEvent } from '../driver/index.js';
import type { RequestRunner } from './runner.js';

export function poolRunner(pool: Pool): RequestRunner {
	return {
		run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent> {
			return (async function* () {
				await using pooled = await pool.acquire(signal);
				for await (const event of pooled.connection.execute(req, signal)) {
					yield event;
				}
			})();
		},
	};
}
