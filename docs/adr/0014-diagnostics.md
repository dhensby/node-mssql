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
| Core (kernel) | `mssql:query`, `mssql:batch`, `mssql:execute`, `mssql:bulk`, `mssql:prepare`, `mssql:transaction:begin`, `mssql:transaction:commit`, `mssql:transaction:rollback`, `mssql:transaction:savepoint:begin`, `mssql:transaction:savepoint:rollback`, `mssql:transaction:savepoint:commit`, `mssql:request:info`, `mssql:request:print`, `mssql:request:env-change`, `mssql:query:aborted` |
| Drivers | `mssql:connection:close`, `mssql:connection:reset`, `mssql:connection:error` |
| Pool adapters | `mssql:pool:open`, `mssql:pool:close`, `mssql:connection:open`, `mssql:pool:acquire`, `mssql:pool:release` |

Core's events cover things it directly orchestrates: query / batch / execute / bulk / prepare lifecycles (wrapped in `tracingChannel`), transaction lifecycle, info / print / envChange relayed from the per-request `ResultEvent` stream, and request aborts. Drivers' events cover wire-level observations only they can see — the actual close, the timing of their native reset call, and transient non-fatal errors that didn't close the connection. Pool adapters' events cover their own orchestration — pool lifecycle (open / close), connection open (wrapping `driver.open()`), pool acquire and release. Hook execution timing (`onAcquire` / `onRelease`) is captured by the surrounding `mssql:pool:acquire` / `:release` traces; no separate channel.

### Channel namespace

**Naming convention** — channel segments are kebab-case where multi-word (e.g. `env-change`, `default-timeout`). This is distinct from Node `EventEmitter` events (which we keep camelCase per Node convention), because channel names are part of a colon-separated hierarchy and kebab-segments read more cleanly in that context (`mssql:request:env-change`) and match the convention already established by `undici:*` and similar channel namespaces.

All channels are prefixed `mssql:`. Two shapes:

**Tracing channels** (start / end / asyncStart / asyncEnd / error via `tracingChannel`):

| Channel | Context shape |
|---|---|
| `mssql:query` | `{ sql, params, unsafe, database, connectionId, queryId }` |
| `mssql:batch` | `{ sql, unsafe, database, connectionId, queryId }` |
| `mssql:execute` | `{ procedure, params, database, connectionId, queryId }` |
| `mssql:bulk` | `{ table, rowCount, database, connectionId, queryId }` |
| `mssql:connection:open` | `{ transport, driverName, connectionId }` |
| `mssql:pool:acquire` | `{ poolId, connectionId? }` |
| `mssql:prepare` | `{ sql, unsafe, database, connectionId, preparedId }` |

**Point channels** (single `publish` via `diagnostics_channel.channel`):

| Channel | Context shape |
|---|---|
| `mssql:connection:close` | `{ connectionId, reason, error? }` — carries the optional `error` payload when `reason === 'error'` ([ADR-0010](0010-driver-port.md)) |
| `mssql:connection:reset` | `{ connectionId, durationMs }` — driver-emitted, fires when the native reset call completes (`sp_reset_connection` for tedious, equivalent for msnodesqlv8). Hook timing for `onAcquire` / `onRelease` is captured by the surrounding `mssql:pool:acquire` / `:release` traces, not by this channel. |
| `mssql:connection:error` | `{ connectionId, error }` — transient/non-fatal error that did not close the connection (keepalive recoverable, parse-level warning, etc.). Fatal errors that close the connection surface as `mssql:connection:close` with `reason: 'error'`. |
| `mssql:request:info` | `{ connectionId, queryId, number, state, class, message, serverName?, procName?, lineNumber? }` — severity ≤ 10 non-print server message during a request |
| `mssql:request:print` | `{ connectionId, queryId, message }` — T-SQL `PRINT` output or `RAISERROR` with severity 0 |
| `mssql:request:env-change` | `{ connectionId, queryId, type, oldValue, newValue }` — TDS environment change (database, language, collation, packet size, isolation level) |
| `mssql:transaction:begin` | `{ connectionId, transactionId, isolationLevel }` |
| `mssql:transaction:commit` | `{ connectionId, transactionId }` |
| `mssql:transaction:rollback` | `{ connectionId, transactionId }` |
| `mssql:transaction:savepoint:begin` | `{ connectionId, transactionId, savepointId, name }` — savepoint created (`SAVE TRANSACTION <name>` on the wire) |
| `mssql:transaction:savepoint:rollback` | `{ connectionId, transactionId, savepointId }` — savepoint-targeted rollback (`ROLLBACK TRANSACTION <name>` on the wire) — distinct from the full `mssql:transaction:rollback` |
| `mssql:transaction:savepoint:commit` | `{ connectionId, transactionId, savepointId }` — savepoint finalised into the parent transaction's work. API-level marker only, no wire round-trip (TDS has no `RELEASE SAVEPOINT` verb — see [ADR-0008](0008-query-lifecycle-and-disposal.md)). Fires when `Savepoint.release()` clears the savepoint from the rollback-target list. The `:commit` naming mirrors the parent transaction's lifecycle: a savepoint commits its work into the parent (which may itself later commit or roll back). |
| `mssql:query:aborted` | `{ queryId, reason, signalReason?, error? }` — `reason` (the *source* of the abort): `'user-abort'` (user AbortSignal, including during pool acquire) \| `'default-timeout'` (the wall-clock `defaultTimeout` fired on a buffered terminal — see [ADR-0013](0013-cancellation-and-timeouts.md); streaming terminals auto-disable this, so they never produce this reason) \| `'early-terminate'` (library-initiated from an early `break` / `return` / `throw` in `for await`) \| `'error'` (including `PoolAcquireTimeoutError` from tarn-style adapter-internal timeout firing). `signalReason` (the *meaning* of a signal-driven abort): populated when `reason === 'user-abort'`, carries the raw `signal.reason` — typically a `DOMException` whose `name` is `'TimeoutError'` (from `AbortSignal.timeout()`) or `'AbortError'` (from `controller.abort()`), or any value the consumer passed to `controller.abort(x)`. Subscribers classify with `signalReason?.name === 'TimeoutError'` or `instanceof` against their own sentinel types. See [ADR-0013](0013-cancellation-and-timeouts.md) |
| `mssql:pool:open` | `{ poolId, adapter, durationMs? }` — pool has completed initialisation and is ready to serve acquires. Captures whatever init the adapter does — eager population (tarn with `min > 0`), validating an initial connection, etc. — and `durationMs` reports how long that took. For lazy adapters that do no work on open, `durationMs` is 0 or omitted. Fires once per pool lifetime. `adapter` is the adapter's `name` (`'tarn'`, `'singleConn'`, etc.) for fleet observability. |
| `mssql:pool:close` | `{ poolId, reason, durationMs? }` — pool has fully torn down. `reason` is `'drain'` (graceful drain via `pool.drain()`) or `'destroy'` (force close via `pool.destroy()`). `durationMs` captures the close duration. Fires once per pool lifetime. |
| `mssql:pool:release` | `{ poolId, connectionId }` |

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

**`database` on per-query channels** is the database name in effect on the connection at terminal-firing time (the kernel tracks current-database via `mssql:request:env-change`). This is what an OTEL instrumentation maps to `db.namespace` — having it on the query span directly avoids forcing the instrumentation to correlate `connectionId` against the connect event and replay env-change history.

**`unsafe` on `mssql:query` / `:batch` / `:prepare`** is `true` when the SQL came from `sql.unsafe(text, params)` ([ADR-0006](0006-queryable-api.md)) and `false` when it came from a tagged-template `` sql`...` ``. Consumers use this to apply different downstream policies — for example, an OTEL instrumentation may include tagged-template `sql` text in `db.query.text` by default but redact `unsafe` SQL unless explicitly opted in (since `unsafe` text might contain values interpolated by the user rather than parameterised). The flag is informational: the library does not redact based on it; subscribers decide.

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
| `db.namespace` | `database` field on `mssql:query` / `:batch` / `:execute` / `:bulk` / `:prepare` |
| `db.query.text` | `sql` on the same channels; instrumentation can use the `unsafe` flag to apply different redaction policy for `sql.unsafe()` text |
| `db.operation.name` | derived by the instrumentation from SQL text parsing |
| `server.address` | `transport.host` from `mssql:connection:open` |
| `server.port` | `transport.port` from `mssql:connection:open` |
| `db.mssql.instance_name` | `transport.instance` from `mssql:connection:open` |
| `error.type` | error class name from `mssql:query:aborted.error` or terminal-thrown error |
| `db.response.status_code` | derived by the instrumentation from `mssql:query:aborted.reason` |

**Span lifecycle.** `mssql:query` (and `:batch` / `:execute` / `:bulk` / `:prepare`) tracingChannel `start` / `asyncEnd` map to OTEL span start / end. `mssql:query:aborted`, `mssql:request:info` (severity ≥ a threshold the instrumentation chooses), and `mssql:request:print` become span events on the active span. Pool / connection lifecycle channels are typically not span-emitting in their own right — they feed span attributes via the `connectionId` correlation (e.g., `mssql:connection:open` populates `server.address` for spans on connections that came from that open).

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
- `mssql:query:aborted`'s `reason` names the *source* of the abort (user signal vs library default timeout vs early-terminate vs error); `signalReason` exposes the *meaning* of a signal-driven abort (the raw `signal.reason`, typically a `DOMException` named `'TimeoutError'` or `'AbortError'`, or a consumer-supplied value). Subscribers who want to classify "was this a timeout?" without enumerating `reason` values inspect `signalReason?.name`. The same value is preserved on the thrown error's `.cause`, so log-and-trace consumers and catch-site consumers see identical data.
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

## References

- [PR #1846 on v12](https://github.com/tediousjs/node-mssql/pull/1846) — shipped in v12.4.0; v13 carries the design forward and expands it.
- [node-redis PR #3195](https://github.com/redis/node-redis/pull/3195) — reference implementation of the same pattern.
- [Node `diagnostics_channel` docs](https://nodejs.org/api/diagnostics_channel.html)
- [OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/) — what `@opentelemetry/instrumentation-mssql` would target; our channel context is shaped to map onto these attributes without requiring the instrumentation to correlate across multiple events.
- [`@opentelemetry/instrumentation-undici`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/node/instrumentation-undici) — the modern reference for `tracingChannel`-based OTEL instrumentation; the structural template for what an mssql instrumentation would look like.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parameterization guarantees that mean parameter values are a discrete field in channel context (separate from SQL text), making consumer-side redaction trivially scoped.
- [ADR-0012: Credential and Transport](0012-credential-and-transport.md) — defines the `Transport` shape that `mssql:connection:open`'s context derives from.
- [ADR-0013: Cancellation](0013-cancellation-and-timeouts.md) — source of `mssql:query:aborted`.
- [tediousjs/node-mssql#840](https://github.com/tediousjs/node-mssql/issues/840) — remove `debug`.
