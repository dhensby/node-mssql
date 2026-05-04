# ADR-0014: Diagnostics via `diagnostics_channel` and `tracingChannel`

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 uses the `debug` npm package (issue #840 tracks its removal) for internal logging. `debug` is a runtime dependency, requires an environment variable to enable, and does not integrate with any modern observability tool without user-side shim code. OpenTelemetry auto-instrumentation, structured log pipelines, APM vendors — none of them hook into `debug`.

Node 18.19+ / 19.9+ ships `diagnostics_channel.tracingChannel`, the standard Node-native way to expose library activity to observability tools. OpenTelemetry's `@opentelemetry/instrumentation-*` packages subscribe to tracing channels and emit spans without the library importing OTEL. `undici`, `node:http`, `node-redis` all use this pattern.

PR #1846 on v12 introduced a `diagnostics_channel` integration in v12.4.0, taking inspiration from `node-redis` PR #3195. v13 carries that design forward as the spine, expanding the channel set to cover the full `Queryable` / pool / driver lifecycle.

## Decision

The library publishes activity on `diagnostics_channel`. No other logging mechanism. No dependency on `debug`, OTEL, or any APM SDK.

The channel namespace, channel names, and event payload shapes are defined in core. Drivers and pool adapters publish on those channels directly for events they're authoritative about. Coordination is by importing typed channel constants from core, not by string convention — TypeScript catches drift at compile time, so a driver renaming an event or shipping an off-shape payload is a build failure rather than a silent observability bug.

### Emitter responsibilities

| Emitter | Channels |
|---|---|
| Core (kernel) | `mssql:query`, `mssql:execute`, `mssql:prepare`, `mssql:transaction:begin`, `mssql:transaction:commit`, `mssql:transaction:rollback`, `mssql:transaction:savepoint:begin`, `mssql:transaction:savepoint:rollback`, `mssql:transaction:savepoint:commit`, `mssql:request:info`, `mssql:request:print`, `mssql:request:env-change`, `mssql:client:state-change` |
| Drivers | `mssql:connection:close`, `mssql:connection:reset`, `mssql:connection:error` |
| Pool adapters | `mssql:pool:open`, `mssql:pool:close`, `mssql:connection:open`, `mssql:pool:acquire`, `mssql:pool:release` |

Core's events cover things it directly orchestrates: query / batch / execute / bulk / prepare lifecycles (wrapped in `tracingChannel`), transaction lifecycle, and info / print / envChange relayed from the per-request `ResultEvent` stream. Cancellations and errors ride the same tracingChannel as their parent operation — `asyncEnd` for clean terminations (natural drain or user-explicit cancel), `error` for timeouts and genuine failures — see "Cancellation vs error" below. Drivers' events cover wire-level observations only they can see — the actual close, the timing of their native reset call, and transient non-fatal errors that didn't close the connection. Pool adapters' events cover their own orchestration — pool lifecycle (open / close), connection open (wrapping `driver.open()`), pool acquire and release. Hook execution timing (`onAcquire` / `onRelease`) is captured by the surrounding `mssql:pool:acquire` / `:release` traces; no separate channel.

### Channel namespace

**Naming convention** — channel segments are kebab-case where multi-word (e.g. `env-change`, `default-timeout`). This is distinct from Node `EventEmitter` events (which we keep camelCase per Node convention), because channel names are part of a colon-separated hierarchy and kebab-segments read more cleanly in that context (`mssql:request:env-change`) and match the convention already established by `undici:*` and similar channel namespaces.

All channels are prefixed `mssql:`. Two shapes:

**Tracing channels** (start / end / asyncStart / asyncEnd / error via `tracingChannel`):

| Channel | Context shape |
|---|---|
| `mssql:query` | `{ sql, params, unsafe, database, serverAddress, serverPort?, connectionId, queryId }` |
| `mssql:execute` | `{ procedure, params, database, serverAddress, serverPort?, connectionId, queryId }` |
| `mssql:connection:open` | `{ transport, driverName, connectionId }` |
| `mssql:pool:acquire` | `{ poolId, connectionId?, stats }` — `stats: PoolStats` is a snapshot of pool gauges at acquire-call time (`size`, `available`, `inUse`, `pending`); see "Pool stats on acquire/release" below |
| `mssql:prepare` | `{ sql, unsafe, database, serverAddress, serverPort?, connectionId, preparedId }` |

**Point channels** (single `publish` via `diagnostics_channel.channel`):

| Channel | Context shape |
|---|---|
| `mssql:connection:close` | `{ connectionId, reason, error? }` — carries the optional `error` payload when `reason === 'error'` ([ADR-0010](0010-driver-port.md)) |
| `mssql:connection:reset` | `{ connectionId, durationMs }` — driver-emitted, fires when the native reset call completes (`sp_reset_connection` for tedious, equivalent for msnodesqlv8). Hook timing for `onAcquire` / `onRelease` is captured by the surrounding `mssql:pool:acquire` / `:release` traces, not by this channel. |
| `mssql:connection:error` | `{ connectionId, error }` — transient/non-fatal error that did not close the connection (keepalive recoverable, parse-level warning, etc.). Fatal errors that close the connection surface as `mssql:connection:close` with `reason: 'error'`. |
| `mssql:request:info` | `{ connectionId, queryId, database, number, state, class, message, serverName?, procName?, lineNumber? }` — severity ≤ 10 non-print server message during a request |
| `mssql:request:print` | `{ connectionId, queryId, database, message }` — T-SQL `PRINT` output or `RAISERROR` with severity 0 |
| `mssql:request:env-change` | `{ connectionId, queryId, database, type, oldValue, newValue }` — TDS environment change (database, language, collation, packet size, isolation level). For `type === 'database'`, `database` reflects the post-change value and equals `newValue`; the prior value remains on `oldValue`. |
| `mssql:transaction:begin` | `{ connectionId, transactionId, isolationLevel }` |
| `mssql:transaction:commit` | `{ connectionId, transactionId }` |
| `mssql:transaction:rollback` | `{ connectionId, transactionId }` |
| `mssql:transaction:savepoint:begin` | `{ connectionId, transactionId, savepointId, name }` — savepoint created (`SAVE TRANSACTION <name>` on the wire) |
| `mssql:transaction:savepoint:rollback` | `{ connectionId, transactionId, savepointId }` — savepoint-targeted rollback (`ROLLBACK TRANSACTION <name>` on the wire) — distinct from the full `mssql:transaction:rollback` |
| `mssql:transaction:savepoint:commit` | `{ connectionId, transactionId, savepointId }` — savepoint finalised into the parent transaction's work. API-level marker only, no wire round-trip (TDS has no `RELEASE SAVEPOINT` verb — see [ADR-0008](0008-query-lifecycle-and-disposal.md)). Fires when `Savepoint.release()` clears the savepoint from the rollback-target list. The `:commit` naming mirrors the parent transaction's lifecycle: a savepoint commits its work into the parent (which may itself later commit or roll back). |
| `mssql:client:state-change` | `{ from, to }` — fires once per `client.state` transition (`pending` ↔ `open` ↔ `draining` ↔ `destroyed`). Subscribers use this for readiness probes (flip to 503 on `'draining'` so SIGTERM-shutdown doesn't race new traffic), APM lifecycle timelines, and lifecycle-aware test fixtures, without polling `client.state`. |
| `mssql:pool:open` | `{ poolId, adapter, durationMs? }` — pool has completed initialisation and is ready to serve acquires. Captures whatever init the adapter does — eager population (tarn with `min > 0`), validating an initial connection, etc. — and `durationMs` reports how long that took. For lazy adapters that do no work on open, `durationMs` is 0 or omitted. Fires once per pool lifetime. `adapter` is the adapter's `name` (`'tarn'`, `'singleConnection'`, etc.) for fleet observability. |
| `mssql:pool:close` | `{ poolId, reason, durationMs? }` — pool has fully torn down. `reason` is `'drain'` (graceful drain via `pool.drain()`) or `'destroy'` (force close via `pool.destroy()`). `durationMs` captures the close duration. Fires once per pool lifetime. |
| `mssql:pool:release` | `{ poolId, connectionId, stats }` — `stats: PoolStats` snapshot at release time, same shape as on `:acquire` |

IDs in context come from a library-wide object-ID scheme.

**`transport` shape on `mssql:connection:open`** is a documented subset of `Transport` ([ADR-0012](0012-credential-and-transport.md)) — the network-and-login attributes that observability tools care about, omitting things that are either large/binary or driver-private:

```ts
{
  host: string
  port?: number
  database?: string
  instance?: string
  appName?: string
  applicationIntent?: 'readOnly' | 'readWrite'   // fleet observability — which AG replica
  trustServerCertificate?: boolean               // security signal worth surfacing
  encrypt?: boolean                              // included only when scalar; EncryptOptions objects omitted
}
```

`Transport.serverCertificate` (binary), `Transport.native` (driver-opaque), and any rich `EncryptOptions` form are not emitted.

**`database` on per-query and request side-channels** is the database name in effect on the connection at the time the event fires (the kernel tracks current-database via `mssql:request:env-change`). On per-query channels (`:query` / `:execute` / `:prepare`) it captures the database at terminal-firing time; on request side-channels (`:request:info` / `:print` / `:env-change`) it captures the database at the moment the side-channel event fires, which can differ from the parent query's start-time database when a request executes a `USE` mid-flight. For `:env-change` events with `type === 'database'`, the field reflects the post-change value (equal to `newValue`); the prior database is on `oldValue`. This is what an OTEL instrumentation maps to `db.namespace` — having it on every event avoids forcing the instrumentation to correlate `connectionId` against the connect event and replay env-change history, and lets info/print messages emitted after a mid-request `USE` carry the correct database for span-event attribution.

**`serverAddress` / `serverPort` on per-query channels** are the host and port of the connection serving the query — sourced from `Transport.host` / `Transport.port` on the underlying `Connection` ([ADR-0012](0012-credential-and-transport.md)) and surfaced unchanged. These map onto OTEL's `server.address` and `server.port` attributes. Like `database`, they are threaded onto every query event so an instrumentation populates span attributes from a single event without maintaining a `connectionId → host` correlation map. Unlike `database`, they are constant for a connection's lifetime; the kernel pulls them once when the connection is acquired and reuses the values across every query that runs on that connection. `serverPort` is optional because the underlying `Transport.port` is optional (named instances connect via `instance` + SQL Browser without a fixed port at the user-facing config layer).

**`unsafe` on `mssql:query` / `:prepare`** is `true` when the SQL came from `sql.unsafe(text, params)` ([ADR-0006](0006-queryable-api.md)) and `false` when it came from a tagged-template `` sql`...` ``. Consumers use this to apply different downstream policies — for example, an OTEL instrumentation may include tagged-template `sql` text in `db.query.text` by default but redact `unsafe` SQL unless explicitly opted in (since `unsafe` text might contain values interpolated by the user rather than parameterised). The flag is informational: the library does not redact based on it; subscribers decide.

**`params` shape on per-query channels** is a string-keyed map. Each entry carries the parameter's SqlType and the user-supplied JS value:

```ts
interface ChannelParam {
  type: SqlType        // SqlType marker — sql.Int, sql.VarChar, sql.Bit, etc.
  value: unknown       // user-supplied JS value, raw (consumer-side redaction per
                       // "SQL and parameter values in context" above)
}

params: Record<string, ChannelParam>
```

Both `type` and `value` are always populated. The driver requires a SqlType for every parameter to encode it on the wire, so by the time we publish the channel — after request build, before dispatch — a type is known for every entry. Procedure builder users supply it explicitly (`.input('id', sql.Int, 123)`); tagged-template and `sql.unsafe()` users get the same JS-value-to-SqlType inference the driver applies for the wire format (number → Int, string → NVarChar, Buffer → VarBinary, Date → DateTime, etc.). `value` is the user's JS value unchanged; the driver's wire-level coercion (e.g. `true` → bit `1`) is not applied at the channel layer — observability cares about what the user wrote, not the wire shape.

Key semantics depend on the parameter source:

- **`mssql:query`** (tagged-template `` sql`...` ``) — positional params; keys are stringified zero-based indexes (`'0'`, `'1'`, ...) reflecting the interpolation order. Tagged-template params have no user-facing names.
- **`mssql:query`** with `unsafe: true` (from `sql.unsafe(text, params)`) — keys are the user-supplied parameter names from the object form (`{ id: 123 }`) or stringified indexes from the array form (`[123]`).
- **`mssql:execute`** (procedure builder) — keys are the parameter names declared via `.input()` / `.inout()` / `.output()`.

**Direction is implicit, not a field.** `params` (on start context) carries `in` and `inout` parameters — `inout` entries appear with their *input* value (what's sent to the server). Pure `out` parameters do not appear in `params`; their values come back at `asyncEnd` via the `outputs` field already specced in the asyncEnd shape. `inout` parameters appear in both: in `params` at start with the input value, in `outputs` at asyncEnd with the output value the server returned. Consumers correlate by key to see the round-trip.

Direction expressivity depends on the source: tagged-template `` sql`...` `` and `sql.unsafe(text, params)` (object or array form) are input-only — neither has an API surface to declare `inout` or `out` direction. Only the procedure builder ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)) declares directional parameters via `.input()` / `.inout()` / `.output()`, so only `mssql:execute` populates `outputs` at `asyncEnd` with returned values; `mssql:query`'s `outputs` is always empty or absent.

`mssql:prepare`'s start context lists no `params` — the prepare itself does not bind values, only declares the parameter shape. Subsequent execution of a `PreparedStatement` ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)) publishes on `mssql:execute` with the bound `params` populated as above.

**`asyncEnd` context shape.** The tracingChannel-based channels extend the context object at `asyncEnd` with result-related fields. Subscribers reading the same context at `asyncEnd` see the start fields plus a common termination block, plus per-channel additions on the success path.

Common to all tracingChannel channels at `asyncEnd`:

| Field | Meaning |
|---|---|
| `reason: 'completed' \| 'cancelled'` | How the operation ended on the non-error path. `'completed'` is natural drain (terminal resolved with rows / meta). `'cancelled'` is a user-explicit cancel: `Query.cancel()`, an early `break` / `return` / `throw` inside `for await`, or a consumer `AbortSignal` whose `signal.reason` was *not* a `'TimeoutError'`-named `DOMException`. Genuine error outcomes — timeouts, server errors, driver failures — fire on the tracingChannel `error` channel; see "Cancellation vs error" below. |
| `phase?: AbortPhase` | Populated when `reason === 'cancelled'`. The `AbortPhase` value the kernel stamped on the abort: `'pool-acquire'` \| `'connect'` \| `'dispatch'` \| `'response'` \| `'transaction-begin'` \| `'transaction-commit'` \| `'transaction-rollback'` \| `'savepoint'` \| `'rollback-to-savepoint'` \| `'prepare'` \| `'unprepare'`. The kernel stamps the same value on the catch-site `AbortError` / `TimeoutError`'s `phase` field, so a consumer subscribing to `asyncEnd` and a consumer catching the thrown error see identical phase classification. |
| `error?: AbortError` | Populated when `reason === 'cancelled'`. The `AbortError` the kernel produced for the cancellation, with `.cause` carrying the original `signal.reason` for signal-driven cancels (typically a `DOMException` named `'AbortError'`, or any value the consumer passed to `controller.abort(x)`). Lets subscribers reading only `asyncEnd` classify the cancellation in the same shape catch-site code sees, without subscribing to a separate channel. |

Per-channel additions on the success path (`reason: 'completed'`):

| Channel | Additions |
|---|---|
| `mssql:query` / `:execute` | `rowsAffected: number` (total across statements), `rowsAffectedPerStatement: number[]`, `rowCount: number` (rows returned to the consumer), `rowsetCount: number`, `outputs?: Record<string, unknown>`, `returnValue?: number` |
| `mssql:prepare` | `preparedId: string` (server-assigned handle id, populated only on success) |

Durations are not on context — `tracingChannel` captures start/end timestamps and instrumentations derive duration from those automatically. Result fields populate from the request's TDS `DONE` / `DONE_IN_PROC` / `DONEPROC` tokens at the same time the kernel populates `QueryMeta` ([ADR-0007](0007-query-result-presentation.md)) — same source of truth, exposed at the channel layer so an OTEL instrumentation can populate span attributes (`db.response.returned_rows`, etc.) directly from `asyncEnd` without subscribing to `:request:info` / `:env-change` and correlating by `queryId`.

### Cancellation vs error

Operation outcomes split deliberately across `asyncEnd` and the tracingChannel `error` channel:

- **`asyncEnd`** fires for outcomes subscribers should record but **should not alert on**. `reason: 'completed'` is natural drain; `reason: 'cancelled'` is a user-explicit termination — `Query.cancel()`, early `break` / `return` / `throw` inside `for await`, or a consumer `AbortSignal` whose `signal.reason` was not a timeout. These are intentional terminations; an OTEL instrumentation maps them to span status `OK` (with a "cancelled" event for the `'cancelled'` case), not `ERROR`. Operational dashboards and alerting pipelines should not page on them.
- **`error`** fires for outcomes subscribers **should** alert on. `defaultTimeout` firing on a buffered terminal, or a consumer signal whose `signal.reason` was a `'TimeoutError'`-named `DOMException` (i.e. from `AbortSignal.timeout()`), produces a `TimeoutError`. Genuine query failures (`QueryError`, `ConstraintError`, `ConnectionError`, `DriverError`, etc.) likewise fire on `error`. An OTEL instrumentation maps these to span status `ERROR` and records the exception. The `error` channel's published value is the same `MssqlError` instance the terminal rejects with — same identity, same `.cause` chain — so log-and-trace consumers and catch-site consumers see identical data.

The kernel categorises signal-driven aborts — the only ambiguous case — by inspecting `signal.reason` at the moment of abort:

- `signal.reason` is a `DOMException` whose `name === 'TimeoutError'` (i.e. produced by `AbortSignal.timeout()`) → fire `error` with `TimeoutError`.
- Otherwise (`signal.reason` is a `DOMException` named `'AbortError'`, or any other value the consumer passed to `controller.abort(x)`) → fire `asyncEnd` with `reason: 'cancelled'`.

`defaultTimeout` firing is unambiguous: always a timeout, always fires `error` with `TimeoutError`. Library-initiated aborts from `for await` early-terminate (`break` / `return` / `throw`) are likewise unambiguous: always intentional terminations, always fire `asyncEnd` with `reason: 'cancelled'`. The catch-site error in the early-terminate case is library-internal (the consumer's break/return/throw is their own exit, not a thrown library error); the asyncEnd context's `error` field exposes the internal `AbortError` so subscribers see the classification anyway.

This split mirrors the error taxonomy: `TimeoutError` is genuinely unexpected (server load, deadlocks, client-side misconfiguration) and should reach operators; `AbortError` from explicit user cancel is intentional and should not. The diagnostics surface and the catch-site error class agree on this categorisation, so a consumer choosing to subscribe at either layer arrives at the same conclusion.

**Pool stats on acquire/release** — `mssql:pool:acquire` start context and `mssql:pool:release` carry a `stats: PoolStats` snapshot at the moment the channel fires. `PoolStats` is the polled-snapshot type defined on the Pool port ([ADR-0011](0011-pool-port.md)): `{ size, available, inUse, pending }`. Two reasons:

- **Contention visibility.** A `pending > 0` reading at acquire time tells subscribers "this acquire was queued behind others." `Promise.all([q1, q2, q3])` against a saturated pool (any pool, but most visible against the no-pool short-circuit `SingleConnection` which holds exactly one connection) shows up cleanly: subsequent acquires in the batch report `pending` values reflecting the queue ahead of them. Without this, observability tools have to schedule their own polling against `pool.stats` to catch contention.
- **OTEL gauge population.** OpenTelemetry's [database conventions](https://opentelemetry.io/docs/specs/semconv/database/) define `db.client.connection.usage` (≈ `inUse`), `db.client.connection.idle.max` (≈ `size - inUse`), `db.client.connection.pending_requests` (≈ `pending`). Including the snapshot on every acquire/release event lets an instrumentation populate those gauges from the event stream — no separate ticker, no correlated polling.

### SQL and parameter values in context

The library emits SQL text and parameter values **raw** on `diagnostics_channel`. There is no library-side redaction or opt-in mechanism. This matches the convention every other database client in the ecosystem follows — `pg`, `mysql2`, `mongodb` all emit raw and leave redaction to the consumer.

The rationale for keeping redaction at the consumer layer:

- Different consumers want different redaction policies. An OTEL instrumentation defaults to *omitting* parameter values per the OpenTelemetry semantic conventions; a structured-log forwarder may want to apply environment-specific PII filters; a debug subscriber in development may want everything. The library cannot pick one default that fits all of them.
- Once a value is on the channel, every subscriber sees it — but each subscriber decides what to forward downstream. Redacting at the library level would lose information that some subscribers legitimately want; redacting at the subscriber level is precise to that subscriber's purpose.
- Keeping the library out of redaction keeps the API surface and implementation simple. There are no `diagnostics: { ... }` flags, no per-param predicate, no per-channel rules. The library publishes facts; consumers shape facts into spans / logs / traces.

The channel context separates SQL text from parameter values as discrete fields (`sql` and `params`), making consumer-side redaction trivially scoped — a redactor can drop `params` entirely without touching `sql`, or filter `params` by name, or transform values, etc. The parameterised-first design of the queryable API ([ADR-0006](0006-queryable-api.md)) guarantees this separation: parameter values are never embedded inside the `sql` text from a tagged template. Subscribers building their own redaction don't have to parse SQL to extract literals.

The query-family channel contexts also carry an **`unsafe: boolean`** flag indicating whether the SQL came from `sql.unsafe(text, params)`. Consumers use this to apply policy: tagged-template SQL is a code artefact that's safe to log; `sql.unsafe()` SQL might contain user-interpolated values inline. A typical consumer policy is "emit `sql` for tagged-template (`unsafe: false`), redact for `unsafe: true` unless explicitly opted in." The library does not act on this flag — it just surfaces it for subscribers to act on.

For OpenTelemetry instrumentation specifically: the [OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/) define how parameter values should be handled (default conservative, opt-in via instrumentation config such as `enhancedDatabaseReporting`). A future `@opentelemetry/instrumentation-mssql` would follow that convention. For structured-log consumers (pino, winston) or custom subscribers, the consumer applies its own redaction — common patterns include name-based filtering or env-aware switches. None of those are the library's prescription.

### OTEL semantic-convention mapping

A future `@opentelemetry/instrumentation-mssql` (out-of-scope for this library, but expected to exist — this design is built to enable one cleanly) maps our channels onto the OpenTelemetry [database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/):

| OTEL attribute | Source |
|---|---|
| `db.system` | constant `'mssql'` |
| `db.namespace` | `database` field on `mssql:query` / `:execute` / `:prepare` |
| `db.query.text` | `sql` on the same channels; instrumentation can use the `unsafe` flag to apply different redaction policy for `sql.unsafe()` text |
| `db.query.parameter.<key>` | entries on `params` from per-query channels — key is parameter name (procedure / unsafe object-form) or stringified index (tagged-template / unsafe array-form); the OTEL spec accepts either |
| `db.operation.name` | derived by the instrumentation from SQL text parsing |
| `server.address` | `serverAddress` on the per-query channel (also `transport.host` on `mssql:connection:open`) |
| `server.port` | `serverPort` on the per-query channel (also `transport.port` on `mssql:connection:open`) |
| `db.mssql.instance_name` | `transport.instance` from `mssql:connection:open` |
| `error.type` | error class name from the tracingChannel `error` channel's published error |
| `db.response.status_code` | for query errors, `QueryError.number` (T-SQL error number); not populated for cancellations or non-server failures |

**Span lifecycle.** `mssql:query` (and `:execute` / `:prepare`) tracingChannel `start` maps to OTEL span start. `asyncEnd` maps to span end and supplies the OTEL status: `reason: 'completed'` → status `OK`; `reason: 'cancelled'` → status `OK` with a "cancelled" span event populated from the `error` field on context. The tracingChannel `error` channel maps to OTEL status `ERROR` with the recorded exception — this is where `TimeoutError`, `QueryError`, `ConnectionError`, etc. land. `mssql:request:info` (severity ≥ a threshold the instrumentation chooses) and `mssql:request:print` become span events on the active span. Pool / connection lifecycle channels are typically not span-emitting in their own right — they feed span attributes via the `connectionId` correlation (e.g., `mssql:connection:open` populates `server.address` for spans on connections that came from that open).

**No SQL Server instrumentation exists today.** The closest precedents are `@opentelemetry/instrumentation-pg` and `-mysql2`, both currently monkey-patched (pre-`diagnostics_channel`-adoption). The modern reference is `@opentelemetry/instrumentation-undici`, which uses `tracingChannel` subscriptions. Our channel design follows that precedent — an OTEL instrumentation for us would look structurally similar to the undici one. The library's responsibility is to expose what an instrumentation library needs in its channel contexts and not invert that boundary by importing OTEL types directly.

### No direct OTEL dependency

Core never imports `@opentelemetry/*`. OpenTelemetry integration happens via the user installing `@opentelemetry/instrumentation-mssql` (out-of-scope for this library) or by writing a thin `diagnostics_channel.subscribe` adapter. We will document the adapter shape; we will not ship it.

### Contributor tracing

Removing `debug` means contributors lose the `DEBUG=mssql* node script.js` development workflow. The replacement is documented in the contributor guide:

```ts
import diagnostics_channel from 'node:diagnostics_channel'
diagnostics_channel.channel('mssql:query').subscribe(msg => console.log(msg))
```

A `scripts/trace.mjs` helper in the repo wraps the same idea with flags for filtering channels by name — convenience for contributors, not a published API.

## Consequences

- Zero observability dependencies in core. Users bring their own OTEL / APM wiring if they want one.
- Auto-instrumentation through `@opentelemetry/instrumentation-mssql` (if someone writes one) needs no custom code in user apps — it will just work.
- `debug`-based workflows (issue #840) do not carry forward. Contributors and power users use `diagnostics_channel.subscribe` directly.
- Channel names are a stable API surface. Adding a channel is a non-breaking minor; renaming or removing one is a breaking change. The list above is the v13.0 surface.
- Operation outcomes split across `asyncEnd` (clean terminations — `reason: 'completed'` for natural drain, `reason: 'cancelled'` for user-explicit cancel) and the tracingChannel `error` channel (timeouts and genuine errors). This mirrors what operators actually want: `error` is the alert-worthy channel; `asyncEnd` records timing and clean cancellations without paging anyone. The kernel inspects `signal.reason.name` to categorise signal-driven aborts: a `'TimeoutError'`-named `DOMException` (i.e. from `AbortSignal.timeout()`) becomes a `TimeoutError` on `error`; anything else becomes `reason: 'cancelled'` on `asyncEnd`. The catch-site error class and the diagnostics categorisation agree, so log-and-trace consumers and catch-site consumers see identical data — the `error` channel publishes the same `MssqlError` instance the terminal rejects with, and `asyncEnd`'s `error` field carries the `AbortError` for cancellations including its `.cause` chain.
- SQL text and parameter values are emitted raw on `diagnostics_channel`. Redaction is the consumer's concern — OTEL instrumentations follow the OpenTelemetry convention (default conservative, opt-in to widen); structured-log subscribers apply their own filters. The library publishes facts and keeps its API surface minimal: no `diagnostics: { ... }` config, no per-param predicate, no library-side filtering rules. This matches `pg` / `mysql2` / `mongodb` precedent.
- Channel contexts include `database` on every per-query event so an OTEL instrumentation can populate `db.namespace` directly without correlating across `connectionId` and replaying env-change history. The kernel tracks current-database via `mssql:request:env-change` and threads it onto query events automatically.
- A future `@opentelemetry/instrumentation-mssql` is the expected consumer of this design. The channel shape is built to map cleanly onto OTEL database semantic conventions; the library does not import OTEL itself, but exposes what an instrumentation needs.

## Alternatives considered

**Keep `debug` alongside `diagnostics_channel`.** Rejected — two logging mechanisms is twice the maintenance for no durable benefit once `diagnostics_channel` ships. Issue #840 is specifically a request to drop `debug`.

**Import OTEL directly and emit spans.** Rejected — pins a version, brings a transitive surface we do not control, and makes non-OTEL users pay the install cost. Tracing channels are the Node-idiomatic hook.

**Sanitize SQL text (strip literals) before emitting.** Rejected — this library is parameterized-first; literals in the SQL text come from the user's source code, not from external input. Sanitizing would hide what the user actually wrote. Consumers that need sanitised text for downstream privacy reasons apply their own transformation at the subscriber layer.

**Library-side redaction with opt-in flags (`includeParameterValues`, `includeUnsafeSql`, `redactParam`).** Considered. An earlier draft applied conservative defaults at the library — parameter values redacted as `'[redacted]'` unless opted in, `sql.unsafe()` text redacted unless opted in, with a per-param predicate for fine-grained control. Rejected because every other database client in the ecosystem (`pg`, `mysql2`, `mongodb`) emits raw and lets the consumer redact. The rationale for diverging — that `diagnostics_channel` is fan-out and a careless subscriber could leak — was real but applies equally to those libraries; the ecosystem's answer is "instrumentation libraries default conservative; consumers configure their own pipelines as needed", which works fine at scale. Keeping our channel emission raw matches that precedent, removes a user-facing config surface, and keeps the library's job simple: publish facts, let consumers shape them.

**Emit on `process.emit('mssql:query', ...)`.** Rejected — `process.emit` is not a documented extension surface and collides with whatever other libraries might do. `diagnostics_channel` is the documented one.

**Emit structured-log objects (pino / winston style) instead of channel publishes.** Rejected — structured logs are one *consumer* of diagnostics; diagnostics is more general. A user who wants pino output subscribes to channels and forwards to pino. A user who wants OTEL spans subscribes and forwards to OTEL. Core does not assume a log format.

**Expose `db.collection.name` (target table) on per-query context.** Considered. Two paths were on the table: parse the SQL inside the kernel to extract the first table name, or add a user hint slot (`q.tag({ collection: 'users' })`). Rejected for v13.0 — SQL parsing is fragile in the presence of CTEs, joins, subqueries, and multi-statement batches, and meaningfully extracting "the target table" usually requires a query-builder's structural view of the statement rather than text parsing. The established `@opentelemetry/instrumentation-pg` and `-mysql2` precedent is best-effort instrumentation-side parsing; an `@opentelemetry/instrumentation-mssql` author can do the same against `sql` on our channel context. A user-supplied collection hint is a separate API question that can be added by the OTEL instrumentation library (or a future v13 minor) without changing core's channel surface.

## References

- [PR #1846 on v12](https://github.com/tediousjs/node-mssql/pull/1846) — shipped in v12.4.0; v13 carries the design forward and expands it.
- [node-redis PR #3195](https://github.com/redis/node-redis/pull/3195) — reference implementation of the same pattern.
- [Node `diagnostics_channel` docs](https://nodejs.org/api/diagnostics_channel.html)
- [OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/) — what `@opentelemetry/instrumentation-mssql` would target; our channel context is shaped to map onto these attributes without requiring the instrumentation to correlate across multiple events.
- [`@opentelemetry/instrumentation-undici`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/node/instrumentation-undici) — the modern reference for `tracingChannel`-based OTEL instrumentation; the structural template for what an mssql instrumentation would look like.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parameterization guarantees that mean parameter values are a discrete field in channel context (separate from SQL text), making consumer-side redaction trivially scoped.
- [ADR-0012: Credential and Transport](0012-credential-and-transport.md) — defines the `Transport` shape that `mssql:connection:open`'s context derives from.
- [ADR-0013: Cancellation](0013-cancellation-and-timeouts.md) — source of the asyncEnd `reason` field and the `error`-vs-`asyncEnd` categorisation rules.
- [tediousjs/node-mssql#840](https://github.com/tediousjs/node-mssql/issues/840) — remove `debug`.
