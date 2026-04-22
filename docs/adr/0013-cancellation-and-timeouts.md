# ADR-0013: Cancellation and timeouts via AbortSignal

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 has two ways to stop an in-flight request:

- `request.cancel()` on a tedious request (driver-level).
- `connectionTimeout` / `requestTimeout` configured at pool or request level.

Composing these is error-prone — issue #1529 tracks "per-request timeout" specifically because no clean mechanism exists. Meanwhile, the rest of the Node ecosystem has converged on `AbortSignal` for cancellation, `AbortSignal.timeout(ms)` for deadlines, and `AbortSignal.any([...])` for composition (Node 20.3+, part of our runtime target — [ADR-0003](0003-runtime-targets.md)).

The v13 design uses `AbortSignal` exclusively. No bespoke `.cancel()`, no `.timeout()` sugar, no abstracting `AbortSignal` away. Users already know the primitive; we just honour it.

## Decision

Every terminal on a `Query`, every scope factory, and every procedure call accepts an `AbortSignal` via a `.signal(s)` chain step:

```ts
await sql`select * from users where id = ${id}`.signal(req.signal)
await sql`...`.signal(AbortSignal.timeout(5000))
await sql`...`.signal(AbortSignal.any([req.signal, AbortSignal.timeout(5000)]))

await using tx = await sql.transaction().signal(req.signal)
```

Behaviour when a signal aborts:

1. Core calls the driver's cancel path ([ADR-0010](0010-driver-port.md)) — `request.cancel()` on tedious, equivalent on msnodesqlv8.
2. The terminal rejects with an `AbortError` (`name: 'AbortError'`, matching `fetch` / Node convention).
3. Core emits `mssql:query:aborted` on `diagnostics_channel`.
4. The connection is returned to the pool. The default session-reset behaviour on release ([ADR-0011](0011-pool-port.md) / issue #1483) calls `Connection.reset()` before the next acquire.

### Default timeout — wall-clock for buffered terminals

`createClient({ defaultTimeout: 30_000 })` configures a wall-clock timeout that applies to **buffered terminals**: `await` / `.all()` / `.run()` / `.rowsets()` awaited, and scope-factory acquires (`sql.acquire()`, `sql.transaction()`, `tx.savepoint()`). The timer starts when the terminal fires and runs for the entire query lifetime — there is no first-byte disarm. This matches the wall-clock model that .NET `SqlCommand.CommandTimeout`, JDBC `Statement.setQueryTimeout`, and pg `query_timeout` use, so users coming from those libraries find the behaviour unsurprising.

**Default value is `0`, which means disabled.** Users opt in to a wall-clock safety net by setting a positive value; users who don't set it get no library-imposed deadline.

```ts
createClient({ defaultTimeout: 30_000 })   // 30s wall-clock for every buffered query

// Buffered: defaultTimeout applies for the entire query lifetime
const rows = await sql`select * from users`         // fails at 30s if not done
const meta = await sql`update t set x = 1`.run()    // same
const [users, orders] = await sql`select * from users; select * from orders`.rowsets()

// Scope acquires: defaultTimeout applies until the handle is yours
await using conn = await sql.acquire()              // 30s for the pool wait
await using tx   = await sql.transaction()          // 30s for acquire + BEGIN
```

**Streaming terminals auto-disable the default.** `for await`, `.iterate()`, and `.rowsets()` iterated have no library-imposed deadline — the library knows the consumption mode at terminal-firing time, and a wall-clock timer that kills mid-stream is a footgun for ETL and large-result-set workloads. The terminal choice is the consumption mode; the consumption mode is the timeout policy. Users who want a streaming deadline pass one explicitly:

```ts
// No library timer; streams as long as the consumer keeps reading.
for await (const row of sql`select * from big_table`) { ... }
const it = sql`select * from big_table`.iterate()

// User-supplied deadline via .signal:
for await (const row of sql`...`.signal(AbortSignal.timeout(5 * 60_000))) { ... }
```

**Once a scope handle is yours, `defaultTimeout` is no longer in force on the scope itself.** Inside an `await using tx = await sql.transaction()` block, the transaction's lifetime is your concern; the library does not impose a deadline on how long you hold it. Inner queries get their own treatment per the rules above (defaultTimeout for buffered, no-timer for streaming, plus the scope signal — see below).

**`.signal(s)` replaces the default.** A user-supplied per-call signal takes over the deadline for that terminal. No silent composition. If the user passes a 60s signal with a 5s default configured, the deadline is 60s — the default would otherwise silently cap the user's explicit intent at 5s, which is exactly the bug class we are designing against.

To opt out of `defaultTimeout` for a single buffered call without supplying a meaningful deadline, pass an unaborted signal:

```ts
const noTimeout = new AbortController().signal
await sql`big query I expect to be slow`.signal(noTimeout)
```

We deliberately do not provide a `.signal(null)` shortcut for this — passing the signal you mean is more honest, and the explicit-disable case is rare enough in practice that the construction one-liner is fine.

For the common "user abort plus a safety-net whole-query deadline" composition, the user writes it explicitly:

```ts
.signal(AbortSignal.any([userSignal, AbortSignal.timeout(safetyNet)]))
```

Safety-net values depend on the workload; there is no single sensible default the library could pick, so the library does not try.

**Behaviour per outcome:**

- **`defaultTimeout` fires (buffered terminal still in flight)**: in-flight work is aborted via the same cancel path as `AbortSignal` (driver cancel if a request was dispatched; pool-queue cancellation if still acquiring). Terminal rejects with a `TimeoutError` (an `AbortError`-family, `name: 'TimeoutError'`). `mssql:query:aborted` fires with `reason: 'default-timeout'`.
- **Streaming terminal**: no library timer fires. The terminal runs until the consumer stops iterating, the user's `.signal()` aborts, the request errors, or natural completion.
- **User `.signal()` aborts**: driver cancel, terminal rejects with `AbortError`, `reason: 'user-abort'`. The user's signal remains in force for the entire request lifetime, including during streaming.

### Scope-level cancellation

A signal supplied at scope creation acts as a **scope-level enforcement point** that propagates to every operation inside that scope. It is independent of, and additional to, any per-call signals or `defaultTimeout` applied to inner operations:

- **`sql.acquire().signal(s)`** — `s` aborts while waiting for the pool to give us a connection. Once the connection is acquired, `s` continues to apply: any subsequent in-flight query on the reserved connection is cancelled if `s` aborts, and the connection returns to the pool with reset on disposal.
- **`sql.transaction().signal(s)`** — same as `acquire`, plus the transaction-specific teardown. When `s` aborts:
  1. Any in-flight query inside the transaction is driver-cancelled.
  2. All savepoints created within this transaction become invalidated — subsequent `.release()` / `.rollback()` calls on those savepoint handles throw, because the parent transaction is being torn down.
  3. The transaction itself rolls back on disposal (the `await using tx` scope's `[Symbol.asyncDispose]` runs `.rollback()`).
  4. The connection is released back to the pool with `Connection.reset()`.

   The whole subtree comes apart cleanly without the consumer having to wire teardown by hand.
- **`tx.savepoint().signal(s')`** — `s'` aborts the savepoint's own work: in-flight queries cancelled, the savepoint rolls back on disposal. The parent transaction is unaffected unless its own signal also fires. A savepoint that inherited the parent transaction's signal also aborts when the parent aborts — propagation cascades down the scope tree.

**Propagation is one-way down the scope tree.** A transaction's signal aborting cascades to its inner savepoints and queries; an inner query's signal aborting does not affect the parent transaction. This matches the principle that scope handles own their inner operations, not the other way round.

**Composition with per-call signals.** Individual terminals inside a scope may still override with their own `.signal()` — the scope-level signal and the terminal-level signal compose via `AbortSignal.any` *for that terminal*. The terminal sees a signal that aborts when *either* fires. This is safe to compose because both are explicit user inputs, unlike the `defaultTimeout` case (where a per-call signal *replaces* the default rather than composing with it).

**Composition with defaultTimeout.** For an inner buffered terminal where the user has set neither a per-call signal nor inherited a scope signal: `defaultTimeout` applies on its own. If a scope signal is in effect but no per-call signal: the scope signal applies; `defaultTimeout` does not (the scope signal is a user input, treated like a per-call signal for replacement purposes).

## Consequences

- No bespoke cancellation API to maintain. Users who know `fetch` know this.
- Timeouts are not a first-class concept beyond `defaultTimeout` — per-call deadlines are a specific use of `AbortSignal.timeout()`. The library has one mental model.
- `defaultTimeout` is wall-clock for buffered terminals, default 0 (disabled). Users who know .NET / JDBC / pg find the behaviour familiar — the conventions match. Streaming terminals auto-disable so the wall-clock never silently kills a `for await` mid-stream.
- Users who want a strict per-call SLA pass `.signal(AbortSignal.timeout(N))` (or compose with their own signal). The cost is the explicitness of saying "this query has SLA N"; the benefit is no silent override of user intent for queries that need different deadlines.
- Driver cancel semantics vary (TDS cancel is cooperative; ODBC's is a blocking call). Wrapping both behind `AbortSignal` smooths this over — drivers expose `cancel` as part of the port ([ADR-0010](0010-driver-port.md)) and core is the one orchestrating.
- Streaming workloads (`for await`, `.iterate()`, `.rowsets()` iterated) auto-disable `defaultTimeout`. Users paging through large result sets don't have to opt out of a timer that wouldn't make sense for streaming — the consumption mode chooses the policy. A streamed query runs as long as the user keeps consuming, and per-call `.signal()` is the explicit opt-in for a whole-lifetime deadline on streaming.
- Scope-level signals propagate down the scope tree: a transaction signal aborting cancels in-flight queries, invalidates savepoint handles, rolls back the transaction on disposal, and releases the connection. Consumers don't have to wire teardown manually.
- Diagnostics subscribers can distinguish timeout origin via `mssql:query:aborted`'s `reason` field: `'default-timeout'` (library default), `'user-abort'` (user signal), `'early-terminate'` (library-initiated from a `for await` `break` / `return` / `throw`), or `'error'`. Operational dashboards that page on timeouts can filter out library-initiated `early-terminate` events cleanly.
- For the `'user-abort'` case specifically, the channel also carries `signalReason` — the raw `signal.reason`. `AbortSignal.timeout()` produces a `DOMException` with `name: 'TimeoutError'`; `controller.abort()` with no argument produces a `DOMException` with `name: 'AbortError'`; `controller.abort(customReason)` propagates whatever the consumer passed. This lets subscribers distinguish "user-driven whole-query deadline" from "HTTP client disconnected" from "application-defined custom signal" without the library having to enumerate those cases as `reason` values. The same value is on the thrown error's `.cause`, so catch-site code and diagnostics subscribers see identical classification data.

## Alternatives considered

**`.timeout(ms)` sugar on terminals.** Rejected — it is one-character shorter than `.signal(AbortSignal.timeout(ms))` but the extra API surface is not worth it. Users who want terser can write `const to = AbortSignal.timeout`.

**Automatic default-timeout wrapping of user signals.** Rejected for the race-condition reason above. The naive implementation changes user-observable behaviour silently when a default timeout is changed, which is a class of bug worth preventing by construction.

**Separate `acquireTimeout` and `responseStartTimeout` settings.** Considered — an earlier draft split the pre-first-byte budget into two phases (pool queue vs driver dispatch-to-first-byte) so each could have its own cap. Rejected because most users do not care *which phase* consumed the budget; "I gave this 5 seconds to start streaming and it didn't" is the question they want to answer, and a single combined timer answers it directly. The phase split was paying a configuration-complexity cost for a distinction that is only useful to a small minority of operators, who can still get it via `diagnostics_channel` tracing channels (`mssql:pool:acquire` start/end durations vs `mssql:query` start-to-first-event duration).

**Pure wall-clock default with no streaming auto-disable (v12's `requestTimeout`).** Rejected because it is load-bearing *wrong* for streaming workloads: any non-zero default silently caps how long `for await` can run, and users doing legitimate long-streaming ETL jobs have to set it to a very high value (or `Infinity`) which defeats the safety purpose for every short-running query using the same client. The chosen design — wall-clock for buffered terminals only, with streaming terminals auto-disabling — keeps the familiar wall-clock semantic for the OLTP path while letting the same client also serve streaming workloads correctly. The terminal's consumption mode is the timeout policy.

**First-byte-disarming default (mirroring `fetch` / `http.headersTimeout`).** Considered. The first-byte disarm is unambiguously safe for streaming and removes the streaming footgun entirely. Rejected because (a) it is unusual relative to other database clients (.NET, JDBC, pg, mysql2 all use wall-clock), so users coming from those libraries find the behaviour surprising; (b) it imposes no protection on `.all()` calls that take a long time to drain, even though `.all()` is buffered consumption where a wall-clock makes sense. The wall-clock-with-streaming-auto-disable model gives the same streaming protection while matching the broader DB-client convention for buffered terminals.

**`CancellationToken` / custom primitive.** Rejected — the ecosystem is on `AbortSignal`. Any new primitive is immediate tech debt.

**Expose `request.cancel()` directly on `Query`.** Considered for parity with v12. Rejected because it is redundant with `AbortSignal` and creates two ways to do the same thing. Users who want imperative cancel can create an `AbortController`, wire its signal, and call `.abort()`.

## References

- [ADR-0003: Runtime targets](0003-runtime-targets.md) — `AbortSignal.any()` requires Node 20.3+.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — `.signal()` chain position.
- [ADR-0010: Driver port](0010-driver-port.md) — `execute(req, signal)` on `Connection`.
- [ADR-0011: Pool port](0011-pool-port.md) — `acquire(signal)` on `Pool`.
- [tediousjs/node-mssql#1529](https://github.com/tediousjs/node-mssql/issues/1529) — per-request timeout request.
