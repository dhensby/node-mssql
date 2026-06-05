# v13 implementation roadmap

This is the living plan for completing the v13 rewrite. It is driven by the [ADRs](adr/): design decisions are written as ADRs, reviewed, and **Accepted** before implementation. Work is executed as **vertical slices** — each slice is a thin end-to-end cut (core API → driver port → tedious adapter → unit + live-server integration tests), not a horizontal layer. Keep this file current as slices land and as draft ADRs are accepted; it is the single source of truth for "what's left", so it must not live only in conversation.

## How we work

- **ADR-driven.** Anything touching the public API, the driver port, or a cross-package contract gets an ADR ([template](adr/template.md)). ADRs move **Draft → (review) → Accepted → implemented.**
- **Accepted ADRs are the implementation queue. Draft ADRs are the review queue** — they need review and acceptance before they can be built.
- **Vertical slices.** Each slice delivers one capability end-to-end and ships green across the unit and live-server integration suites.

## Status at a glance (Accepted ADRs)

| ADR | State | Remaining work |
|-----|-------|----------------|
| 0001 Scope · 0002 Branch · 0003 Runtime · 0005 Release/CI | ✅ done | 0005's release-please gate is intentionally off until alpha |
| 0004 Monorepo layout | 🟡 partial | meta `mssql` package + driver/pool adapter packages not bootstrapped |
| 0006 Queryable API | 🟡 partial | per-query `.signal()` not exposed (`.one()` correctly deferred to v13.1) |
| 0007 Result presentation | 🟡 partial | `request:info/print/env-change` channels; `errorOnInfo`; `ColumnMetadata` is name+nullable only; `StateError` vs ADR's `TypeError` |
| 0008 Query lifecycle | 🟡 partial | terminal tracingChannel outcomes (cancelled/timeout); signal exit-path (same wiring gap) |
| 0009 Sprocs & prepared | ❌ not started | whole builder family + `Procedure`/`PreparedStatement` + `Query<T,O>` refactor — blocked on ADR-0019 |
| 0010 Driver port | 🟡 partial | tedious `prepare()`/`bulkLoad()` stubbed; no `close` event; `reset()` no DB-context restore; empty TypeRegistry |
| 0011 Pool port | 🟡 partial | no `@tediousjs/mssql-tarn` adapter; hook `Queryable` binder stubbed; no pool diagnostics |
| 0012 Credential/transport | 🟡 partial | tedious: `password` + 4 transport fields only (accessToken/tokenProvider/driverNative + 9 fields + `native` missing) |
| 0013 Cancellation/timeouts | 🟡 partial | no `defaultTimeout`; no per-query `.signal()`; scope signal reaches acquire only |
| 0014 Diagnostics | 🟡 partial | 1 of ~25 channels published; `tracingChannel` unused |
| 0015 Connection strings | ❌ not started | no parser, no dependency, no string overload — placeholder type only |
| 0016 Object IDs | 🟡 partial | `idGenerator` override unwired; no `client.id`/`pool.id` |
| 0017 Errors · 0018 Client lifecycle · 0024 Lifecycle primitives | ✅ done | tarn error-translation lands with the tarn package; minor `ClientClosedError` race-wrap |

## Done — the kernel

The promise-/TypeScript-native, hexagonal, single-queryable, `AsyncDisposable` foundation is in and green:

- The `sql` tag and `Query`/`ResultStream` terminals — `.all`/`.iterate`/`.run`/`.result`/`.rowsets`/`.raw`/`.columns`/`.meta`/`.cancel`/`.dispose`, single-consumption, `MultipleRowsetsError` (ADR-0006/0007/0008).
- The driver port plus the tedious adapter's execute/transaction/savepoint/reset/ping vertical with native error mapping (ADR-0010).
- Client lifecycle — `createClient`/`connect`/`close`/`destroy`, the 4-state machine, `AsyncDisposable` (ADR-0018).
- The pool **port** and the built-in `SingleConnectionPool` short-circuit (ADR-0011).
- Transactions and savepoints (ADR-0006).
- The `MssqlError` taxonomy and driver translation (ADR-0017); object-ID format (ADR-0016); lifecycle primitives `createStateMachine`/`onceAsync` (ADR-0024); the runtime floor + `eslint-plugin-n` enforcement (ADR-0003).
- The diagnostics scaffold — `mssql:client:state-change` (ADR-0014, first channel only).

## Draft ADRs — review queue

These need review and acceptance before implementation:

- **ADR-0019 — SQL type system and type tags. Review first.** It is the keystone: ADR-0009 (sprocs/prepared), the driver `TypeRegistry` (ADR-0010), enriched `ColumnMetadata` (ADR-0007), and later TVPs all build on it.
- **ADR-0022 — Per-Query lifecycle event surface.** Review.
- **ADR-0020 (TVPs) / ADR-0021 (Bulk).** Drafts, and ADR-0001 already defers them to post-v13.0 — review when their phase arrives. Both still use the pre-ADR-0019 `sql.*` tag names; fold the `sql.* → types.*` rename into that review.
- **ADR-0023 — `RequestRunner`.** Anomaly: it is *implemented* (`packages/core/src/query/runner.ts` + `pool-runner.ts`) but still marked Draft. Quick review → mark Accepted.

## Remaining work — phased plan

Each item is a vertical slice (core → driver port → tedious → unit + live-server integration).

### Phase 0 — reconcile + unblock (small, can start now)

1. **Expose per-query `.signal()`** (ADR-0013/0006/0008). The internal plumbing (`QueryOptions.signal` → `ResultStream` composed signal → driver cancel) is already built and idle; only the public wiring on the tag/`Query` is missing. This one primitive unblocks per-query cancel, per-query deadlines, and scope→query signal propagation.
2. **`idGenerator` override + `client.id`/`pool.id`** (ADR-0016). Add `idGenerator?: IdGenerator` to `ClientConfig`, thread it through `nextId(prefix, generator)` call sites (the `DriverOptions.id` seam already exists for connection ids).
3. **Reconcile `StateError` vs `TypeError`** (see Open decisions). Most likely an ADR edit to 0007/0008.
4. **Housekeeping.** Promote ADR-0023 to Accepted; fix stale header comments in `packages/tedious/src/connection.ts` (claims transactions unimplemented — they are) and `packages/core/src/pool/pool.ts` (claims types-only — `SingleConnectionPool` runtime exists).

### Phase 1 — diagnostics backbone (ADR-0014)

Build `tracingChannel` plus the full `mssql:*` channel set. This is a shared dependency: it satisfies the telemetry halves of ADR-0007 (`request:info/print/env-change`), ADR-0008 (terminal `asyncEnd reason:'cancelled'` / `error` → `TimeoutError`), ADR-0013 (cancel/timeout outcome split), and ADR-0011 (pool channels) in one pass.

### Phase 2 — timeouts + scope signals (ADR-0013)

`defaultTimeout` (wall-clock, streaming terminals auto-disable, signal replaces default — no silent composition) and scope-tree signal propagation (a scope abort cancels in-flight queries and tears the scope down), composing scope + per-call signals via `AbortSignal.any`.

### Phase 3 — independent verticals (parallelisable)

- **Connection strings** (ADR-0015): add `@tediousjs/connection-string`, the core parser, the tedious `connectionStringSchema`, and the `createClient(string, options?)` overload.
- **Credential/transport round-out** (ADR-0012): tedious `accessToken`/`tokenProvider` (+ re-auth lifecycle, never cached)/`driverNative`, and the nine unmapped `Transport` fields + the `native` escape hatch.
- **Driver-port round-out** (ADR-0010): emit the `close` Connection event; implement `reset()` database-context restoration (ENVCHANGE tracking).

### Phase 4 — packaging

- **`@tediousjs/mssql-tarn` pool adapter** (ADR-0011): the production N-connection pool, the real hook `Queryable` binder, pool diagnostics, and `close`-event eviction.
- **Meta `mssql` package** (ADR-0004/0001): preserve `npm i mssql` — re-export core wired to the default tedious driver + tarn pool.
- Optional: a second driver (`@tediousjs/mssql-msnodesqlv8`).

### Phase 5 — stored procedures & prepared statements (ADR-0009)

Blocked on ADR-0019 acceptance. `Query<T,O>` two-parameter refactor → `sql.procedure()`/`sql.prepare()` builders → `Procedure`/`PreparedStatement` types → driver `prepare()` (ADR-0010) → connection-pinned prepared lifecycle.

### Round-out (fold into the relevant phase)

- `errorOnInfo` predicate on `ClientConfig` → promote `info`→`QueryError` (ADR-0007).
- Enriched `ColumnMetadata` — type/precision/scale/collation (ADR-0007, needs ADR-0019).
- `ClientClosedError` race-path `cause`-wrap of an escaping `PoolClosedError` (ADR-0017).

## Open decisions

- **`StateError` vs `TypeError`.** ADR-0007/0008 mandate `TypeError` for meta-before-termination and terminal-on-disposed; the code throws `StateError` (introduced deliberately in ADR-0017). **Proposed:** amend 0007/0008 to bless `StateError` (consistent with the taxonomy). *Pending confirmation.*
- **Draft reviews.** ADR-0019 first (gates Phase 5); then 0022. *Pending review.*
- **Sequencing.** Phase 0 first, leading with per-query `.signal()`. *Pending confirmation.*

## Deferred (post-v13.0)

Per ADR-0001's non-goals: table-valued parameters (ADR-0020), bulk load (ADR-0021), and SQL CLR types ship as post-v13.0 package releases. Native `sql`-fragment composition is v13.2/v14.
