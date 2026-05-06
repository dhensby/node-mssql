/**
 * `RequestRunner` — connection-acquisition seam for `Query<T>` (ADR-0023).
 *
 * Maps an `ExecuteRequest` to an `AsyncIterable<ResultEvent>`, with
 * connection acquire and release internalised. The implementation differs
 * by scope: pool-bound runners do `pool.acquire` → `connection.execute` →
 * `pool.release` per call (release tied to the iterator's `return()` via
 * an async-generator `try/finally`); reserved-connection / transaction
 * runners delegate directly to `connection.execute` without per-call
 * acquire/release because the connection is already held by the scope.
 *
 * The runner is internal — users get queryables (the bound `sql` tag, a
 * `ReservedConn`, a `Transaction`), not a raw `RequestRunner`. It exists
 * so `Query<T>` can stay uniform across scopes while connection lifecycle
 * varies.
 */

import type { ExecuteRequest, ResultEvent } from '../driver/index.js';

export interface RequestRunner {
	run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent>
}
