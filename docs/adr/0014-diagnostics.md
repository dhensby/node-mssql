# ADR-0014: Diagnostics via `diagnostics_channel` and `tracingChannel`

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 uses the `debug` npm package (issue #840 tracks its removal) for internal logging. `debug` is a runtime dependency, requires an environment variable to enable, and does not integrate with any modern observability tool without user-side shim code. OpenTelemetry auto-instrumentation, structured log pipelines, APM vendors — none of them hook into `debug`.

Node 18.19+ / 19.9+ ships `diagnostics_channel.tracingChannel`, the standard Node-native way to expose library activity to observability tools. OpenTelemetry's `@opentelemetry/instrumentation-*` packages subscribe to tracing channels and emit spans without the library importing OTEL. `undici`, `node:http`, `node-redis` all use this pattern.

PR #1846 on v12 already prototypes a `diagnostics_channel` integration, taking inspiration from `node-redis` PR #3195. v13 adopts that design as the spine.

## Decision

Core publishes activity on `diagnostics_channel`. No other logging mechanism. No dependency on `debug`, OTEL, or any APM SDK.

### Channel namespace

All channels are prefixed `mssql:`. Two shapes:

**Naming convention** — channel segments are kebab-case (`env-change`, `driver-error`, `release-savepoint`, `response-start-timeout`). This is distinct from Node `EventEmitter` events (which we keep camelCase per Node convention), because channel names are part of a colon-separated hierarchy and kebab-segments read more cleanly in that context (`mssql:request:env-change`) and match the convention already established by `undici:*` and similar channel namespaces.

**Tracing channels** (start / end / asyncStart / asyncEnd / error via `tracingChannel`):

| Channel | Context shape |
|---|---|
| `mssql:query` | `{ sql, params, connectionId, queryId }` |
| `mssql:batch` | `{ sql, connectionId, queryId }` |
| `mssql:execute` | `{ procedure, params, connectionId, queryId }` |
| `mssql:bulk` | `{ table, rowCount, connectionId, queryId }` |
| `mssql:connect` | `{ transport, driverName, connectionId }` |
| `mssql:pool:acquire` | `{ poolId, connectionId? }` |
| `mssql:prepare` | `{ sql, connectionId, preparedId }` |

**Point channels** (single `publish` via `diagnostics_channel.channel`):

| Channel | Context shape |
|---|---|
| `mssql:connection:close` | `{ connectionId, reason, error? }` — carries the optional `error` payload when `reason === 'error'` ([ADR-0010](0010-driver-port.md)) |
| `mssql:connection:reset` | `{ connectionId, stage, poolAdapter, durationMs }` — `stage` is `'driver'` (the `sp_reset_connection` call, emitted by the driver), `'on-acquire'` (client `onAcquire` hook, emitted by the pool adapter), or `'on-release'` (client `onRelease` hook, emitted by the pool adapter) — see [ADR-0011](0011-pool-port.md) |
| `mssql:connection:driver-error` | `{ connectionId, error }` — transient/non-fatal driver-internal error that did not close the connection (keepalive recoverable, parse-level warning, etc.). Distinct from `mssql:connection:close` with `reason: 'error'` |
| `mssql:request:info` | `{ connectionId, queryId, number, state, class, message, serverName?, procName?, lineNumber? }` — severity ≤ 10 non-print server message during a request |
| `mssql:request:print` | `{ connectionId, queryId, message }` — T-SQL `PRINT` output or `RAISERROR` with severity 0 |
| `mssql:request:env-change` | `{ connectionId, queryId, type, oldValue, newValue }` — TDS environment change (database, language, collation, packet size, isolation level) |
| `mssql:transaction:begin` | `{ connectionId, transactionId, isolationLevel }` |
| `mssql:transaction:commit` | `{ connectionId, transactionId }` |
| `mssql:transaction:rollback` | `{ connectionId, transactionId }` |
| `mssql:transaction:savepoint` | `{ connectionId, transactionId, savepointId, name }` |
| `mssql:transaction:release-savepoint` | `{ connectionId, transactionId, savepointId }` |
| `mssql:stream` | `{ queryId, rowCount }` — incremental row progress |
| `mssql:query:aborted` | `{ queryId, reason, signalReason?, error? }` — `reason` (the *source* of the abort): `'user-abort'` (user AbortSignal, including during pool acquire) \| `'response-start-timeout'` (the single `defaultTimeout`, covering pool acquire + driver dispatch + wait for first byte) \| `'early-terminate'` (library-initiated from an early `break` / `return` / `throw` in `for await`) \| `'error'` (including `PoolAcquireTimeoutError` from tarn-style adapter-internal timeout firing — [ADR-0017](0017-error-taxonomy.md)). `signalReason` (the *meaning* of a signal-driven abort): populated when `reason === 'user-abort'`, carries the raw `signal.reason` — typically a `DOMException` whose `name` is `'TimeoutError'` (from `AbortSignal.timeout()`) or `'AbortError'` (from `controller.abort()`), or any value the consumer passed to `controller.abort(x)`. Subscribers classify with `signalReason?.name === 'TimeoutError'` or `instanceof` against their own sentinel types. See [ADR-0013](0013-cancellation-and-timeouts.md). `.one()` does **not** produce this channel event — it drains the rest of the response rather than cancelling, so no abort occurs ([ADR-0006](0006-queryable-api.md)) |
| `mssql:query:leaked` | `{ sql }` — dev-mode only, Query GC'd without terminal — [ADR-0008](0008-query-lifecycle-and-disposal.md) |
| `mssql:pool:release` | `{ poolId, connectionId, wasReset, resetDurationMs? }` |

IDs in context come from the object-ID scheme in [ADR-0016](0016-object-id-format.md).

### SQL and parameter values in context

SQL text is included in context by default. Parameter *names*, *counts*, and *types* are included by default. Parameter **values** are **not** included by default — they are opt-in.

The rationale for the split:

- SQL text is a code artefact: it lives in the user's source repository, is typically not sensitive, and is directly useful for identifying which query a span or log line belongs to. Including it by default matches what every tracing integration expects.
- Parameter names, counts, and types describe the shape of the call without exposing the payload. They are useful for debugging ("is the `userId` param being passed as a string or a number?") and carry no privacy risk.
- Parameter values are the payload. In practice, database queries in a typical service carry values that include user identifiers, personal data, access tokens (JOIN against a sessions table), free-text user input, and similar. Even in a SQL-injection-safe, parameterized-first library (which this one is by construction — [ADR-0006](0006-queryable-api.md)), the *values* are often precisely the thing that must not leak into logs, trace backends, or APM vendors where they can be retained, indexed, or accessed by a wider audience than the database itself.

Opting in is one line:

```ts
createClient({
  diagnostics: { includeParameterValues: true }
})
```

With the opt-in set, parameter values appear in context alongside names/types. With it unset (the default), values appear as `'[redacted]'`; everything else is unchanged.

The default was chosen privacy-first because the failure modes are asymmetric: a user who wants values in their logs flips one config option and sees them immediately; a user who did not know values were being logged learns by finding a customer's phone number in a log aggregator months later. For debugging sessions where values are genuinely needed, the option can be set via environment variable in the user's runtime and scoped to the environment where logs are acceptable (local development, staging). The library does not prescribe this mechanism — it just provides the on/off switch; wiring it to an env var is three lines in the user's bootstrap.

Raw-SQL (the `sql.unsafe(text, params)` escape hatch — [ADR-0006](0006-queryable-api.md)) emits the text and params identically, with the same default (values redacted unless opted in). A user who interpolates un-parameterized SQL into `sql.unsafe` has already accepted the injection risk; the library does not second-guess by trying to sanitize the text, but it still defaults-redacts the `params` array for the same reason values are redacted everywhere else.

### No direct OTEL dependency

Core never imports `@opentelemetry/*`. OpenTelemetry integration happens via the user installing `@opentelemetry/instrumentation-mssql` (out-of-scope for this library) or by writing a thin `diagnostics_channel.subscribe` adapter. We will document the adapter shape; we will not ship it.

### Contributor tracing

Removing `debug` means contributors lose the `DEBUG=mssql* node script.js` development workflow. The replacement is documented in the contributor guide:

```ts
import diagnostics_channel from 'node:diagnostics_channel'
diagnostics_channel.channel('mssql:query').subscribe(msg => console.log(msg))
```

This is the five-line version. A `scripts/trace.mjs` helper in the repo wraps it with flags for filtering channels by name — convenience for contributors, not a published API.

## Consequences

- Zero observability dependencies in core. Users bring their own OTEL / APM wiring if they want one.
- Auto-instrumentation through `@opentelemetry/instrumentation-mssql` (if someone writes one) needs no custom code in user apps — it will just work.
- `debug`-based workflows (issue #840) do not carry forward. Contributors and power users use `diagnostics_channel.subscribe` directly.
- Channel names are a stable API surface. Adding a channel is a non-breaking minor; renaming or removing one is a breaking change. The list above is the v13.0 surface.
- `mssql:query:aborted`'s `reason` names the *source* of the abort (user signal vs library default timeout vs early-terminate vs error); `signalReason` exposes the *meaning* of a signal-driven abort (the raw `signal.reason`, typically a `DOMException` named `'TimeoutError'` or `'AbortError'`, or a consumer-supplied value). Subscribers who want to classify "was this a timeout?" without enumerating `reason` values inspect `signalReason?.name`. The same value is preserved on the thrown error's `.cause` ([ADR-0017](0017-error-taxonomy.md)), so log-and-trace consumers and catch-site consumers see identical data.
- Parameter values are redacted (`'[redacted]'`) by default in logs / spans. Debugging sessions that need the values opt in with `diagnostics: { includeParameterValues: true }`, typically scoped via an environment variable so production stays redacted. SQL text and parameter names/types/counts are still emitted — enough to identify which call a span belongs to without exposing the payload.

## Alternatives considered

**Keep `debug` alongside `diagnostics_channel`.** Rejected — two logging mechanisms is twice the maintenance for no durable benefit once `diagnostics_channel` ships. Issue #840 is specifically a request to drop `debug`.

**Import OTEL directly and emit spans.** Rejected — pins a version, brings a transitive surface we do not control, and makes non-OTEL users pay the install cost. Tracing channels are the Node-idiomatic hook.

**Sanitize SQL text (strip literals) before emitting.** Rejected — this library is parameterized-first; literals in the SQL text come from the user's source code, not from external input. Sanitizing would hide what the user actually wrote. The redact-by-default policy on parameter values addresses the legitimate PII concern; SQL text itself is a code artefact.

**Emit on `process.emit('mssql:query', ...)`.** Rejected — `process.emit` is not a documented extension surface and collides with whatever other libraries might do. `diagnostics_channel` is the documented one.

**Emit structured-log objects (pino / winston style) instead of channel publishes.** Rejected — structured logs are one *consumer* of diagnostics; diagnostics is more general. A user who wants pino output subscribes to channels and forwards to pino. A user who wants OTEL spans subscribes and forwards to OTEL. Core does not assume a log format.

## References

- [PR #1846 on v12](https://github.com/tediousjs/node-mssql/pull/1846) — the prototype being carried forward.
- [node-redis PR #3195](https://github.com/redis/node-redis/pull/3195) — reference implementation of the same pattern.
- [Node `diagnostics_channel` docs](https://nodejs.org/api/diagnostics_channel.html)
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parameterization guarantees that make "params in context" safe by default.
- [ADR-0013: Cancellation](0013-cancellation-and-timeouts.md) — source of `mssql:query:aborted`.
- [ADR-0016: Object ID format](0016-object-id-format.md) — the IDs that appear in every context.
- [tediousjs/node-mssql#840](https://github.com/tediousjs/node-mssql/issues/840) — remove `debug`.
