# ADR-0013: Cancellation and timeouts via AbortSignal

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 has three different ways to stop an in-flight request:

- `request.cancel()` on a tedious request (driver-level).
- `connectionTimeout` / `requestTimeout` configured at pool or request level.
- `PreparedStatement.unprepare()` cleanup that conflates resource release with cancellation.

Composing these is error-prone — issue #1529 tracks "per-request timeout" specifically because no clean mechanism exists. Meanwhile, the rest of the Node ecosystem has converged on `AbortSignal` for cancellation, `AbortSignal.timeout(ms)` for deadlines, and `AbortSignal.any([...])` for composition (Node 20.3+, part of our runtime target — [ADR-0003](0003-runtime-targets.md)).

The v13 design uses `AbortSignal` exclusively. No bespoke `.cancel()`, no `.timeout()` sugar, no abstracting `AbortSignal` away. Users already know the primitive; we just honour it.

## Decision

Every terminal on a `Query`, every scope factory, and every procedure call accepts an `AbortSignal` via a `.signal(s)` chain step:

```ts
await sql`select * from users where id = ${id}`.signal(req.signal)
await sql`...`.signal(AbortSignal.timeout(5000))
await sql`...`.signal(AbortSignal.any([req.signal, AbortSignal.timeout(5000)]))

await using tx = await sql.transaction({ signal: req.signal })
```

Behaviour when a signal aborts:

1. Core calls the driver's cancel path ([ADR-0010](0010-driver-port.md)) — `request.cancel()` on tedious, equivalent on msnodesqlv8.
2. The terminal rejects with an `AbortError` (`name: 'AbortError'`, matching `fetch` / Node convention).
3. Core emits `mssql:query:aborted` on `diagnostics_channel` ([ADR-0014](0014-diagnostics.md)).
4. The connection is returned to the pool marked "used." The default session-reset behaviour on release ([ADR-0011](0011-pool-port.md) / issue #1483) will `sp_reset_connection` before the next acquire.

### Single default timeout — "time to first response byte"

`createClient({ defaultTimeout: 5_000 })` configures a single timeout that covers everything from the terminal firing up to the server beginning to respond. It is **disarmed once the first server byte arrives** (COLMETADATA for a SELECT, DONE for a DML, INFO/PRINT if either lands first); from that point on, the library imposes no deadline on how long the response takes to drain.

This mirrors how `http` / `fetch` treat timeouts — Node `http.Server`'s `headersTimeout` is the connection-phase deadline, after which the response body streams for as long as the consumer wants it. The rationale is the same here: failing fast under load is about rejecting work *before* it starts consuming server resources; once rows are streaming, the library does not know whether a long drain is a legitimate ETL job or a stuck query, and guessing the wrong answer is worse than letting the user own that decision.

```ts
createClient({ defaultTimeout: 5_000 })   // fail fast if we can't start receiving within 5s

// Covers all of these in one budget:
// - queuing for a pool connection
// - fresh TCP + TDS login on single-shot deployments
// - waiting for the server to accept the request and send the first byte
```

Users who need a deadline that *does* span the streaming phase — e.g. "the whole query must complete within N seconds, including reading all rows" — opt in per-call with `.signal()`:

```ts
await sql`select * from big_report`
  .signal(AbortSignal.timeout(60_000))     // total-lifetime deadline, user's choice
```

A user-supplied `.signal()` **replaces** `defaultTimeout` entirely. No auto-composition. If the user passes a 60s signal with a 5s default configured, the deadline is 60s — the default would otherwise silently cap the user's explicit intent at 5s, which is exactly the bug class we are designing against.

For the common "user abort plus a safety-net whole-query deadline" composition, the user writes it explicitly:

```ts
.signal(AbortSignal.any([userSignal, AbortSignal.timeout(safetyNet)]))
```

Safety-net values depend on the workload; there is no single sensible default the library could pick, so the library does not try.

**Behaviour per outcome:**

- **`defaultTimeout` fires before first byte**: the in-flight work is aborted via the same cancel path as `AbortSignal` (driver cancel if a request was dispatched; pool-queue cancellation if still acquiring). Terminal rejects with a `TimeoutError` (an `AbortError`-family, `name: 'TimeoutError'`). `mssql:query:aborted` fires with `reason: 'response-start-timeout'`.
- **First byte arrives before the timer fires**: the timer is disarmed. No library-imposed deadline from then on — the response streams as long as the user keeps consuming.
- **User `.signal()` aborts at any point**: driver cancel, terminal rejects with `AbortError`, `reason: 'user-abort'`. The user's signal remains in force for the entire request lifetime, including during streaming — because the user explicitly asked for that semantic.

### Scope-level cancellation

`AbortSignal` also flows through scope factories:

- `sql.acquire({ signal })` — abort while waiting for the pool to give us a connection.
- `sql.transaction({ signal }, fn)` — if the signal aborts mid-transaction, the current statement is cancelled, the transaction is rolled back, and the connection is released.
- Same for `savepoint`.

Individual terminals inside a transaction may still override with their own `.signal()` — the scope-level signal and the terminal-level signal compose via `AbortSignal.any` **within that scope** (this is safe because both are explicit user inputs, unlike the default-timeout case).

## Consequences

- No bespoke cancellation API to maintain. Users who know `fetch` know this.
- Timeouts are not a first-class concept — they are a specific use of `AbortSignal.timeout()`. The library has one mental model instead of two.
- `defaultTimeout` is the only semi-magical configuration, and its behaviour is explicit: it applies only when the user provides no `.signal()` of their own, and disarms on the first server byte.
- Users who want the old v12 behaviour of "always apply a timeout, even when I pass a signal" have to write the composition themselves. The cost is three lines; the benefit is no silent overrides of user intent.
- Driver cancel semantics vary (TDS cancel is cooperative; ODBC's is a blocking call). Wrapping both behind `AbortSignal` smooths this over — drivers expose `cancel` as part of the port ([ADR-0010](0010-driver-port.md)) and core is the one orchestrating.
- Streaming workloads (`for await`, `.iterate()`) are not killed by a hidden whole-query timer. Users paging through large result sets do not have to hunt for and raise a `requestTimeout` setting; the default deadline disarms on first byte. A streamed query runs as long as the user keeps consuming, and per-call `.signal()` is the explicit opt-in for a whole-lifetime deadline.
- Diagnostics subscribers can distinguish timeout origin via `mssql:query:aborted`'s `reason` field: `'response-start-timeout'` (library default), `'user-abort'` (user signal), `'early-terminate'` (library-initiated from `.one()` / `for await` break), or `'error'`. Operational dashboards that page on timeouts can filter out library-initiated `early-terminate` events cleanly.
- For the `'user-abort'` case specifically, the channel also carries `signalReason` — the raw `signal.reason`. `AbortSignal.timeout()` produces a `DOMException` with `name: 'TimeoutError'`; `controller.abort()` with no argument produces a `DOMException` with `name: 'AbortError'`; `controller.abort(customReason)` propagates whatever the consumer passed. This lets subscribers distinguish "user-driven whole-query deadline" from "HTTP client disconnected" from "application-defined custom signal" without the library having to enumerate those cases as `reason` values. The same value is on the thrown error's `.cause` ([ADR-0017](0017-error-taxonomy.md)), so catch-site code and diagnostics subscribers see identical classification data.

## Alternatives considered

**`.timeout(ms)` sugar on terminals.** Rejected — it is one-character shorter than `.signal(AbortSignal.timeout(ms))` but the extra API surface is not worth it. Users who want terser can write `const to = AbortSignal.timeout`.

**Automatic default-timeout wrapping of user signals.** Rejected for the race-condition reason above. The naive implementation changes user-observable behaviour silently when a default timeout is changed, which is a class of bug worth preventing by construction.

**Separate `acquireTimeout` and `responseStartTimeout` settings.** Considered — an earlier draft split the pre-first-byte budget into two phases (pool queue vs driver dispatch-to-first-byte) so each could have its own cap. Rejected because most users do not care *which phase* consumed the budget; "I gave this 5 seconds to start streaming and it didn't" is the question they want to answer, and a single combined timer answers it directly. The phase split was paying a configuration-complexity cost for a distinction that is only useful to a small minority of operators, who can still get it via `diagnostics_channel` tracing channels (`mssql:pool:acquire` start/end durations vs `mssql:query` start-to-first-event duration).

**Whole-query timeout as a client-level default (v12's `requestTimeout`).** Rejected because it is load-bearing *wrong* for streaming workloads: any non-zero default silently caps how long `for await` can run, and users doing legitimate long-streaming ETL jobs have to set it to a very high value (or `Infinity`) which defeats the safety purpose for every short-running query using the same client. Disarming the default on first byte — and letting users opt in to a whole-lifetime deadline per call via `.signal()` — is the only configuration that lets a single client serve both short queries and long streams correctly. This is also the model that `fetch` and `http`'s `headersTimeout` use.

**`CancellationToken` / custom primitive.** Rejected — the ecosystem is on `AbortSignal`. Any new primitive is immediate tech debt.

**Expose `request.cancel()` directly on `Query`.** Considered for parity with v12. Rejected because it is redundant with `AbortSignal` and creates two ways to do the same thing. Users who want imperative cancel can create an `AbortController`, wire its signal, and call `.abort()`.

## References

- [ADR-0003: Runtime targets](0003-runtime-targets.md) — `AbortSignal.any()` requires Node 20.3+.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — `.signal()` chain position.
- [ADR-0010: Driver port](0010-driver-port.md) — `execute(req, signal)` on `Connection`.
- [ADR-0011: Pool port](0011-pool-port.md) — `acquire(signal)` on `Pool`.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — `mssql:query:aborted` event.
- [tediousjs/node-mssql#1529](https://github.com/tediousjs/node-mssql/issues/1529) — per-request timeout request.
