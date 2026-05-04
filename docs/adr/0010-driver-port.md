# ADR-0010: Driver port — hexagonal boundary between kernel and wire protocol

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 imports `tedious` directly across `ConnectionPool`, `Request`, `Transaction`, and `PreparedStatement`. Wire protocol concerns, row decoding, auth translation, and library-level lifecycle are tangled together. This has two costs:

1. **msnodesqlv8 is a second-class citizen.** It is supported but through a separate code path that re-implements much of the library logic. The shapes differ just enough that features landing in one driver often never reach the other.
2. **No third-party driver can exist.** A FreeTDS-based driver, a future greenfield TDS implementation, or a mock driver for testing all require forking the library.

Modern hexagonal architectures solve this by defining a *port* (interface) in the kernel and letting each driver be an *adapter* that implements it. The kernel talks to the port; it never sees the wire protocol.

The v13 unified `Queryable` ([ADR-0006](0006-queryable-api.md)) already defines what the kernel needs from a driver: execute a statement and yield rows, manage transactions, manage prepared handles, reset session state, close. The port is the minimum surface that covers those.

## Decision

`@tediousjs/mssql-core` defines a `Driver` port. Drivers are separate packages that peer-depend on core and implement the port. The port is:

```ts
interface Driver {
  readonly name: string                                     // stable identifier for diagnostics (e.g. 'tedious', 'msnodesqlv8')
  open(opts: DriverOptions): Promise<Connection>
  readonly connectionStringSchema?: ConnectionStringSchema  // driver's connection-string parser
  readonly types: TypeRegistry                              // driver's type coercions
}

interface Connection extends TypedEventEmitter<ConnectionEvents> {
  readonly id: string                                       // library-assigned correlation id
  execute(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent>
  beginTransaction(opts?: TxOptions): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  savepoint(name: string): Promise<void>
  rollbackToSavepoint(name: string): Promise<void>
  prepare(req: PrepareRequest): Promise<PreparedHandle>
  bulkLoad(opts: BulkOptions): Promise<BulkResult>
  reset(): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
}

interface ConnectionEvents {
  close: [{ reason: 'user' | 'remote' | 'error' | 'reset'; error?: MssqlError }]
}
```

`Connection` does not expose `releaseSavepoint(name)` — TDS has no `RELEASE SAVEPOINT` verb (unlike Postgres or SQLite), so there is no wire-level operation for drivers to implement. The kernel's `Savepoint.release()` ([ADR-0008](0008-query-lifecycle-and-disposal.md)) is an API-level marker that clears the savepoint from the rollback-target list — bookkeeping that lives in core, not in drivers.

The full node `EventEmitter` API is available (`on`, `once`, `off`, `addListener`, `removeAllListeners`, etc.), typed to the single event in `ConnectionEvents`. The decision is *what events exist*, not *which EventEmitter methods are allowed*; once we commit to the node EventEmitter pattern, the standard surface is more useful than fighting it.

Row data and per-request side-channel messages (info, print, envChange) are **not** events. They flow out of `execute()` as an `AsyncIterable<ResultEvent>` — a discriminated union:

```ts
type ResultEvent =
  | { kind: 'metadata'; columns: ColumnMetadata[] }
  | { kind: 'row'; values: unknown[] }
  | { kind: 'rowsetEnd'; rowsAffected: number }
  | { kind: 'output'; name: string; value: unknown }
  | { kind: 'returnValue'; value: number }
  | { kind: 'info'; number: number; state: number; class: number; message: string; serverName?: string; procName?: string; lineNumber?: number }
  | { kind: 'print'; message: string }
  | { kind: 'envChange'; type: EnvChangeType; oldValue: string; newValue: string }
  | { kind: 'done' }
```

The kernel consumes this stream to build whatever shape the terminal requires: it threads info/print/envChange into the `QueryMeta` accumulator (available via `q.meta()` after drain — [ADR-0007](0007-query-result-presentation.md)), and publishes them on `diagnostics_channel`. v13.0 deliberately does not ship a per-`Query` `EventEmitter` for these — the listener-lifecycle interaction with re-executable templates does not survive contact with `Procedure` / `PreparedStatement`; see ADR-0007 Alternatives. This is the part of v12's EventEmitter model that caused the most pain — row events conflated with lifecycle, `request.on('row', ...)` leaking request state into application code, `Promise.all` sometimes failing because of it. `AsyncIterable<ResultEvent>` out of `execute()` replaces it at the driver-port layer; per-query observability in v13.0 lives in `q.meta()` after drain (sync access) and `diagnostics_channel` for cross-cutting concerns — not in any per-Query event surface.

The event list is deliberately tight — one entry:

- `close` — connection has finished its lifetime. Reason disambiguates normal teardown (`'user'`), server-initiated close (`'remote'`), fatal error (`'error'`), and pool-triggered reset cycle (`'reset'`). A connection that closes due to a fatal error carries the error in the payload; there is no separate `error` event.

The pool adapter is the documented consumer of `'close'`. A tarn-style adapter does `connection.once('close', evictAndReplace)` on each connection it manages, so a remote-initiated or error-driven close prunes the dead entry from the idle set immediately rather than letting it sit there until the next acquire detects it. Validate-on-acquire (the pool's own ping-and-check) remains as a backstop for races between proactive close detection and the connection being acquired again. Other per-instance subscribers (a custom diagnostic, a single-shot waiter) are possible, but the pool is the consumer the event exists for.

Everything else — per-request info/print/envChange, auth events, keepalive traffic — lives in `ResultEvent` (for per-request data) or `diagnostics_channel` (for observability). Connection-scoped fatal errors are not exposed as a separate `'error'` event; they surface as `close` with `reason: 'error'` and a populated `error` payload. No `'error'` event means no node `EventEmitter` no-listener-crash hazard: pooled idle connections cannot take the process down by emitting unhandled `'error'`.

### Port surface is sized to the real drivers

The mandatory surface above is the superset of what `tedious` and `msnodesqlv8` already do: both support execute, transactions, savepoints, prepare, bulk, reset, and TVP (TVP flows through `execute` as a parameter value; its wire-format encoding is a driver implementation detail). `ping()` is new in v13 — drivers implement it as the cheapest round-trip their protocol allows (a no-op TDS batch for tedious, an ODBC attribute check for msnodesqlv8, a protocol-level keepalive where supported). It exists to give the kernel's `onAcquire` lifecycle hook a primitive to check connection liveness with — addressing [tediousjs/node-mssql#1834](https://github.com/tediousjs/node-mssql/issues/1834). Designing the port around the drivers that actually exist is a deliberate scoping choice — the alternative is speculating about a hypothetical third driver that can only do some subset, and carrying the cost of that abstraction (capability interfaces, runtime feature sets, per-feature type guards) before any real driver needs it.

If and when a driver lands that genuinely cannot honour part of this surface (e.g. a read-replica-only driver that has no business implementing `bulkLoad`, or a mock driver that wants to leave `prepare` unimplemented), we add capability interfaces at that point — promoting the relevant methods into `Preparable` / `BulkCapable` / etc. and narrowing `Connection` to the bedrock. That is additive and non-breaking for drivers that already implement everything: their `Connection` just becomes `Connection & Preparable & BulkCapable & ...`. The deferral is cheap because the refactor does not require changing how drivers are written; it requires moving type declarations.

### `Connection.reset()` is full restoration

`Connection.reset()`'s contract is: **return the connection to its initial-acquired state, including the database context.** Not "do whatever the protocol's reset primitive does and accept what it doesn't cover."

This matters because SQL Server's `sp_reset_connection` (the canonical TDS reset) clears most session state (temp tables, `SET` settings, isolation level, language, etc.) but **preserves the last `USE <database>` selection**. Without intervention, a user who runs `USE other_db` on a pool-bound connection contaminates the database context for whoever acquires that connection next — until the process restarts.

The driver closes that gap. It tracks current database via the TDS `ENVCHANGE` token (type 1 = database change) — already parsed for diagnostics. On reset, it compares current to the initial database (from `Transport.database`, or the server-default captured at login) and layers a `USE <initial>` only when they differ. The common case (database unchanged) costs nothing extra; the rare case (database was changed) pays one batch to revert.

Other protocol-reset survivors that drivers are aware of (e.g. server-side trace flags, certain extended-event subscriptions) are not yet covered — those remain documented edge cases until real demand surfaces. The contract focuses on the database context because that's the canonical cross-acquirer leak.

### Kernel describes intent; drivers translate to wire

The driver port is the only vocabulary the kernel uses for connection-level work. The kernel says `Connection.beginTransaction({ isolationLevel: 'serializable' })`, not "issue `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRAN`." It says `Connection.reset()`, not "call `sp_reset_connection`." It says `prepare(req)` / `PreparedHandle.execute()` / `PreparedHandle.dispose()`, not "execute `sp_prepare` / `sp_execute` / `sp_unprepare`." The driver chooses how to honour each call — `tedious` issues TDS batches and calls `sp_*` system stored procedures, `msnodesqlv8` invokes ODBC functions and connection attributes (`SQL_ATTR_TXN_ISOLATION`, `SQLPrepare`/`SQLExecute`/`SQLFreeHandle`), a future driver might do something else entirely.

This is the property that makes drivers swappable without ripple effects. A driver's wire-level mechanism is its private business; the kernel is shielded from it. Refactoring how a driver implements `reset()` does not touch the kernel; adding a new driver only requires implementing the port, not coordinating with kernel-side code that knows about TDS or ODBC.

Diagnostic events emitted *by drivers* (e.g. the `'driver'` stage of `mssql:connection:reset`) may name the underlying mechanism because that information is genuinely useful at the observability layer. The kernel's *contract* vocabulary does not — it talks intent, port methods, and abstract lifecycle.

Drivers are responsible for:

- Wire protocol (TDS, ODBC, etc.)
- Native auth translation from the core `Credential` shape to driver-native packets.
- Native error mapping to the core `Errors` taxonomy. Drivers throw `MssqlError`-family errors, not driver-native errors.
- Type registry entries for their protocol — SQL2025 JSON/Vector land as `types.Json`/`types.Vector` in whichever driver supports them first.
- Honouring kernel-supplied behavioural configuration: connection-scoped options (e.g. `defaultIsolationLevel` — see [ADR-0006](0006-queryable-api.md)) flow through `DriverOptions` on `open()`; per-call overrides (e.g. `isolationLevel` for one transaction) flow through the relevant method's options bag (`TxOptions.isolationLevel` on `beginTransaction()`). Drivers apply each via whatever native mechanism they prefer — ODBC connection attribute, T-SQL SET batch, login parameter, etc. The contract is that drivers honour the inputs; the wire-level encoding is theirs to optimise.

Drivers are **not** responsible for:

- Pooling — that is the pool port.
- Retry, backoff, or failover.
- Cancellation composition — drivers implement `cancel` on a single request; `AbortSignal.any` composition happens in the kernel.
- Owning the diagnostics-channel namespace — that lives in core. Drivers do publish on the namespace for events they're authoritative about (`mssql:connection:close`, `mssql:connection:reset`, `mssql:connection:error`), but they import typed channel constants from core; they do not invent new top-level channels or rename existing ones.
- `AsyncDisposable`. The driver `Connection` is not itself `AsyncDisposable`. The *library handle* that wraps it (pooled connection, transaction, savepoint) is. Keeping the driver simple means third parties can implement drivers without having to think about disposable semantics.

`createClient({ driver })` takes a driver instance. Core has no runtime dependency on any driver; the first-party drivers are separate packages (`@tediousjs/mssql-tedious`, `@tediousjs/mssql-msnodesqlv8`) that can be installed independently.

## Consequences

- Any driver can be added by any party by implementing the port. The shape is uniform.
- Testing gets a huge boost: a `FakeDriver` that records calls and returns scripted responses is a few hundred lines and enables full unit tests of core without a real server. Future `@tediousjs/mssql-testing` package builds on this.
- Row streaming is `AsyncIterable` end to end. No more `request.on('row', ...)` leaking into application code.
- `instanceof` checks on errors work across the library boundary because drivers peer-depend on core ([ADR-0004](0004-monorepo-layout.md)) and throw core's error classes.
- A driver change does not invalidate application code. Switching `tedious` → `msnodesqlv8` is a line in `createClient`; no kernel-facing behaviour changes.
- The port is wide because both real drivers support the whole surface. Every method listed is something `tedious` or `msnodesqlv8` already implements; none are speculative.
- A driver that cannot honour part of the surface does not exist at the time of writing. If one arrives, capability interfaces (`Preparable`, `BulkCapable`, etc.) become an additive extension — see the deferral note above.
- Driver-specific internals (TVP wire format, ODBC attribute handling, auth packet construction) are entirely hidden inside the driver — users never see them. TVP values, bulk rows, and auth configs go in through the shared types (`ExecuteRequest` parameter values, `BulkOptions`, `Credential`); each driver encodes them however its protocol requires. There is no user-facing divergence at the port level.
- Driver-specific *configuration* that has no cross-driver equivalent (tedious's `cryptoCredentialsDetails`, explicit `tdsVersion` selection; msnodesqlv8's ODBC driver name selection) goes through `transport.native`. This is the only escape hatch a user touches, and its name signals intent — reaching for `transport.native` is a flag to reviewers that the user is stepping outside the portable contract.
- Behavioural settings (transaction isolation level, future additions in the same shape) flow through the driver port rather than being implemented in the kernel — the kernel describes intent, the driver picks the most efficient native mechanism. Keeps the kernel decoupled from wire-format choices and lets each driver carry its own optimisations without ripple effects elsewhere.

## Alternatives considered

**Single `SqlClient` interface covering driver + pool.** Rejected — blurs responsibilities; the pool concerns belong on a separate port.

**Use `node:stream` `Readable` for row data.** Rejected in favour of `AsyncIterable`. Streams are powerful but overkill for row events, they do not type as cleanly, and the `for await` ergonomics of `AsyncIterable` are what the `Queryable` API is built on.

**Keep `EventEmitter` for row events (v12's model).** Rejected — row-level `EventEmitter` is the part of v12's model that causes the most pain: `Promise.all` inconsistency, `request.on('row', ...)` leaking request state into application code, and lifecycle tangled with streaming. `AsyncIterable<ResultEvent>` out of `execute()` replaces it. Note this rejection is scoped to row and side-channel request data — `Connection` itself still extends `EventEmitter` for the `close` lifecycle event because that is a natural fit for the observer pattern (multiple subscribers, no flow control needed, one-shot).

**Narrow `.on()` surface with only `on`/`off`, no `once`/`removeAllListeners`.** Considered. Rejected because the value of `once` (one-shot listeners are common for `close` handlers) and `removeAllListeners` (cleanup paths during teardown) outweighs the marginal cognitive saving of a smaller surface. The decision worth making is *what events exist*, and we made it — keeping the full `EventEmitter` method set for those events costs nothing.

**Expose a connection-scoped `'error'` event.** Rejected — node `EventEmitter`'s no-listener-crash semantics for `'error'` are actively hostile for pooled, long-lived connections that spend most of their lives idle and un-listened-to. We considered overriding `emit('error', ...)` to publish-to-diagnostics-and-return-false, but that is a quiet departure from documented `EventEmitter` semantics that users may rely on for loud-failure signalling. The cleaner answer is not to have the event at all: fatal connection errors surface as a `close` event with `reason: 'error'` and a populated `error` payload, which carries all the same information without the no-listener hazard. Transient or informational driver-internal errors go through `diagnostics_channel`.

**Separate connection-scoped `'info'` event alongside per-request info in `ResultEvent`.** Considered, rejected. Early drafts split info into two surfaces — connection-scoped for things like login banner messages, request-scoped for `PRINT` output and severity-≤10 messages during execute. In practice every info message TDS delivers is tied to a request (login is a request), so the split was theoretical. Collapsed into `ResultEvent` kinds, with `diagnostics_channel` as the observability mirror.

**Capability interfaces shipped in v13.0** (`Connection` as bedrock + `Preparable` / `BulkCapable` / `Savepointable` / `TvpCapable` mixins, with a runtime `capabilities` set and type guards). Considered and drafted. Deferred because every driver that exists at v13.0 release implements the full surface; the abstraction costs more to build and document than it saves today. The shape is documented above so that promoting methods into capability interfaces is an additive refactor when the first asymmetric driver arrives.

**Minimal mandatory `Connection` with everything else hidden behind `transport.native`.** Considered as the opposite extreme. Rejected because TVP, bulk, and prepare are supported by both first-party drivers and are widely used — pushing them through a driver-specific escape hatch would make driver-agnostic application code nearly impossible to write. `transport.native` exists, but only for genuinely single-driver knobs.

**Drivers own their own error classes.** Rejected — `instanceof` across the driver boundary is load-bearing for user code (`if (e instanceof ConnectionError) retry()`). Drivers translating to core's error classes gives users a single taxonomy to reason about regardless of which driver they chose.

**Lazy-load drivers via string names (`driver: 'tedious'`).** Considered for ergonomics — `createClient({ driver: 'tedious' })` is nicer than `createClient({ driver: tedious })`. Rejected because it requires core to know driver package names and reintroduces a runtime coupling we just removed. The explicit import is two lines and makes the dependency graph honest.

## References

- [ADR-0004: Monorepo layout](0004-monorepo-layout.md) — peer-dep discipline that keeps `instanceof` identity intact.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — defines what the kernel needs from a driver.
- [tedious](https://github.com/tediousjs/tedious) — first-party driver adapter target.
- [msnodesqlv8](https://github.com/TimelordUK/node-sqlserver-v8) — second driver adapter target.
