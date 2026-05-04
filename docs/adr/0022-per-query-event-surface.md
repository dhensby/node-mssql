# ADR-0022: Per-Query lifecycle event surface (live `info` / `print` / `envChange`)

- **Status:** Draft
- **Date:** 2026-05-03
- **Deciders:** @dhensby

## Context

[ADR-0007](0007-query-result-presentation.md) ships two surfaces for `info` / `print` / `envChange` messages:

- **Per-query, post-drain via `q.meta()`** — the trailer object accumulates side-channel messages and is read after the stream terminates.
- **Cross-cutting via `diagnostics_channel`** — `mssql:request:info`, `mssql:request:print`, `mssql:request:env-change` publish for every request, for APM and structured logging.

A **live, per-query** band — react to a `PRINT` message *while a long migration is running*, surface env-change events as they arrive — is explicitly deferred. The deferral note states: "the listener-lifecycle interaction with re-executable templates is not yet designed."

The narrow use cases:

- Long-running procedure / migration scripts that emit progress via `RAISERROR WITH NOWAIT` or `PRINT`.
- Interactive debug-proc workflows (T-SQL profiling, tracing-stored-proc output rendered live).
- Cross-acquirer correlation work that wants to react to `envChange` (e.g. detecting a `USE` mid-request).

The cross-cutting `diagnostics_channel` doesn't fit because it has no public `Query` identifier and using it for per-query filtering would be an anti-pattern. `q.meta()` doesn't fit because it's post-drain only.

This ADR specifies the per-Query event surface that closes the gap, with the listener-lifecycle interaction with `Procedure` / `PreparedStatement` resolved.

## Decision

### `Query` extends `TypedEventEmitter<QueryEvents>`

```ts
interface QueryEvents {
  info:      [{ number: number; state: number; class: number; message: string; serverName?: string; procName?: string; lineNumber?: number }]
  print:     [{ message: string }]
  envChange: [{ type: EnvChangeType; oldValue: string; newValue: string }]
}
```

Three events, matching the three side-channel categories `q.meta()` accumulates and `diagnostics_channel` publishes. Same shapes as the diagnostics-channel contexts ([ADR-0014](0014-diagnostics.md)) minus the `connectionId` / `queryId` correlation fields (the user has the `Query` reference, so per-event correlation IDs are redundant).

The full node `EventEmitter` API is available (`on` / `once` / `off` / `addListener` / `removeAllListeners` etc.) typed to the events in `QueryEvents`.

### Listener lifetime — per object, cleared on disposal

Listeners attached to a `Query<T>` persist for the **object's lifetime**:

- **Raw `` sql`...` `` Query** — single-consumption per [ADR-0006](0006-queryable-api.md); listeners fire during the one terminal execution, then the Query is disposed (explicitly via `.dispose()` or implicitly via `await using` scope exit, per [ADR-0008](0008-query-lifecycle-and-disposal.md)). Disposal clears all listeners. There is no listener-leak risk because raw queries don't survive past one execution.
- **`Procedure` / `PreparedStatement`** (re-executable, [ADR-0009](0009-stored-procedures-and-prepared-statements.md)) — listeners persist across executions. A `procedure.on('print', cb)` registered once fires for every `procedure.bind(...).run()` call until the procedure / prepared statement is disposed.

The "listeners persist for the object's lifetime, disposal clears them" rule is **uniform across `Query` and its subtypes** — no inheritance lie. The earlier ADR-0007 concern that re-executable templates would force a different lifecycle was based on a different mental model (listeners as terminal-scoped); making them object-scoped keeps the shape consistent.

### No `'error'` event — errors flow through Promise rejection

The `Query` event surface does not include `'error'` — query failures, timeouts, and aborts surface through the rejection chain on terminals (`.all()`, `.run()`, etc.) per [ADR-0017](0017-error-taxonomy.md). Adding an `error` event would:

- Duplicate the existing rejection-channel semantics.
- Reintroduce the node-`EventEmitter` no-listener-crash hazard for any `Query` whose terminal fired without an `'error'` listener attached — exactly the failure mode `Connection`'s no-`error`-event design ([ADR-0010](0010-driver-port.md)) avoids.
- Make `Procedure` / `PreparedStatement` listener cleanup more consequential (a long-lived Procedure with no error listener would be a process-killer if some execution failed and the `'error'` event went unhandled).

The rejection chain handles errors. The event surface handles informational / progress side-channel signals.

### Listener registration timing

Listeners can be attached before any terminal fires (the lazy-execution model from [ADR-0008](0008-query-lifecycle-and-disposal.md) means the Query is built but inactive until a terminal). Listeners attached *after* a terminal has fired but before the stream drains receive subsequent events on that execution; listeners attached after drain only receive events from future executions (relevant only for re-executable templates).

```ts
const proc = sql.procedure('long_migration')
proc.on('print', ({ message }) => console.log('[migration]', message))

await proc.run()                          // listener fires for every PRINT during execution
await proc.run()                          // same listener still active, fires again
```

For raw queries, `await using` and listener attachment compose naturally:

```ts
await using q = sql`exec long_running_proc`
q.on('print', ({ message }) => log('[proc]', message))
await q                                   // PRINT messages fire to the listener as they arrive
```

### Relationship to `q.meta()` and `diagnostics_channel`

The three surfaces continue to coexist with distinct audiences:

| Surface | Audience | Timing | Scope |
|---|---|---|---|
| `q.meta().info` / `.print` / `.envChanges` | Per-query, post-drain inspection | After stream terminates | One Query |
| `q.on('info' \| 'print' \| 'envChange', cb)` | Per-query, live reaction | As events arrive during execution | One Query (or one Procedure / PreparedStatement across all its executions) |
| `mssql:request:*` channels | Cross-cutting telemetry, APM | As events arrive | All Queries process-wide |

A consumer subscribing at one layer doesn't replace the others — they serve different audiences. The same underlying event fires the listener, accumulates into `q.meta()`'s arrays, and publishes on `diagnostics_channel`.

### Throughput and back-pressure

`info` / `print` / `envChange` events are low-volume relative to row events — typical workloads emit a handful per request, not thousands. Listeners are called synchronously inside the request's read loop; a slow listener does not block row delivery to the consumer's terminal (rows flow on a separate path; events fire as side-channel callouts).

There is no back-pressure on event delivery. If a listener is genuinely slow, it should accept the event into its own queue and process asynchronously — the same model as standard `EventEmitter` consumers.

## Consequences

- Live per-query info / print / envChange reaction becomes a first-class supported pattern.
- The lifecycle rule is uniform across `Query` and its subtypes — no per-subtype divergence.
- Disposal clears listeners; the standard `await using` lifecycle from ADR-0008 carries over.
- Errors stay on the rejection chain; the event surface is for informational signals only.
- The `q.meta()` / `q.on(...)` / `diagnostics_channel` triple covers post-drain inspection, live per-query reaction, and cross-cutting telemetry as three distinct surfaces with one underlying event source.

## Alternatives considered

**Defer indefinitely; use `diagnostics_channel` with a public Query identifier for per-query filtering.** Rejected. ADR-0007 already documents this as an anti-pattern: `diagnostics_channel` is global telemetry, and using it for per-instance filtering requires consumers to maintain a `queryId → handler` correlation map, dispatching back to per-Query handlers. That's reinventing what `EventEmitter` natively provides.

**Listeners cleared after each terminal (per-execution lifecycle).** Rejected on the grounds ADR-0007 originally raised: forces re-registration after every `Procedure.run()` / `PreparedStatement.bind().run()`, which is friction for the dominant re-executable-template use case (one configured handler, many executions).

**Listeners only on `Procedure` / `PreparedStatement`, not on raw `Query<T>`.** Considered. Rejected because the inheritance-lie problem is exactly what ADR-0007 was trying to avoid: subtypes having different listener semantics from their parent. Putting the surface on `Query` and giving raw queries the natural single-consumption lifetime keeps the model uniform.

**Add an `'error'` event.** Rejected for three reasons (covered in the Decision section): duplicates rejection-channel semantics, reintroduces no-listener-crash hazard, makes long-lived re-executable templates fragile.

**Chained `.onInfo(cb)` / `.onPrint(cb)` returning a new immutable Query.** Considered as an alternative spelling. Rejected because it breaks the "subscribe to events on this object" mental model — `q.on('info', cb)` reads as standard `EventEmitter`; `q.onInfo(cb).onPrint(cb)` reads as builder configuration that returns a new object. The latter is more confusing and doesn't compose with `once` / `off` / `removeAllListeners`.

**Yield events alongside rows in the terminal stream (e.g., `.iterate()` returns a discriminated union of `{ kind: 'row' | 'info' | 'print' | 'envChange' }`).** Rejected because it forces every consumer to discriminate, and the dominant use case is "I want rows; tell me about side-channel things if I subscribe." Keeping rows on terminals and side-channel events on the EventEmitter respects the "what you typically want is the easy case" principle.

## Open questions

- Listener-lifetime semantics for `PreparedStatement` post-`.unprepare()` but pre-`.dispose()` — is the prepared-statement object still usable for listener inspection, or should `.unprepare()` clear listeners? Tentative: clear, mirroring how unprepare ends the executable phase.
- Whether to expose a fourth event for `done` / `doneInProc` per-statement boundaries inside multi-statement requests — useful for fine-grained progress reporting on `exec proc1; exec proc2;` shapes. Probably no for v13.0; can be added additively.
- `severity` threshold for `info` events — currently fires for every severity ≤ 10 message. Whether to support per-listener filtering at registration time (`q.on('info', { minSeverity: 5 }, cb)`) or expect consumers to filter inside their handler. Tentative: filter-in-handler; per-listener filtering doesn't earn its place.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — single-consumption raw queries; `await using` lifecycle.
- [ADR-0007: Query result presentation](0007-query-result-presentation.md) — `q.meta()` post-drain inspection; this ADR's deferral note.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — disposal semantics that clear listeners.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — re-executable template semantics.
- [ADR-0010: Driver port](0010-driver-port.md) — `Connection`'s no-`error`-event reasoning, which this ADR's no-`error`-event decision mirrors.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — `mssql:request:info` / `:print` / `:env-change` channels and their context shapes.
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md) — Promise-rejection chain that error handling already uses.
