# ADR-0017: Error taxonomy — `MssqlError` class tree, driver and pool translation

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 leaks driver-native and pool-native errors directly to callers. A `tedious` `RequestError` surfaces with tedious-specific fields; tarn rejects with `Error('aborted')` when a pending acquire is cancelled ([tediousjs/node-mssql#1837](https://github.com/tediousjs/node-mssql/issues/1837)); msnodesqlv8 throws ODBC-shaped errors. Callers end up either (a) `instanceof`-checking across tedious/tarn/msnodesqlv8 types the library technically does not re-export, or (b) matching on `error.message` strings. Both are fragile, neither lets a caller cleanly distinguish "pool is shutting down" from "DB is unreachable" from "query violated a constraint."

Two sibling ADRs already make strong commitments the error taxonomy has to honour:

- **[ADR-0010](0010-driver-port.md)** — drivers translate native errors to the core taxonomy at the port boundary. No tedious/ODBC error shapes leak past the driver.
- **[ADR-0004](0004-monorepo-layout.md)** — drivers peer-depend on core, so `instanceof` on error classes works across the driver boundary. The class identity is load-bearing.

v13 closes the gap by defining the core taxonomy concretely, extending the same "translate at the boundary" discipline to the pool port (addressing #1837), and specifying which of our errors are `MssqlError`-family vs. which deliberately use Node/WebAPI-standard shapes.

## Decision

Core exports one base class and a small tree of subclasses. **Every library-produced error is an `MssqlError` subclass.** Some subclasses also set `name` to `'AbortError'` or `'TimeoutError'` so that `err.name === 'AbortError'` duck-typing (the fetch / undici / AbortSignal ecosystem convention) keeps working alongside `err instanceof MssqlError` and `err instanceof AbortError`. Class-identity and name-convention are complementary, not mutually exclusive — we provide both.

### Class tree

```
Error
└── MssqlError                    // base; every library error extends this
    ├── ConnectionError           // couldn't open, lost mid-session, auth failure
    │   └── CredentialError       // credential/auth-specific — see ADR-0012
    ├── QueryError                // server rejected the statement
    │   └── ConstraintError       // PK/UK/FK/CHECK/NOT NULL violation
    ├── MultipleRowsetsError      // single-rowset terminal hit >1 rowset — ADR-0006
    ├── TransactionError          // BEGIN/COMMIT/ROLLBACK/savepoint mismatch
    ├── PoolError                 // pool-domain failure
    │   └── PoolClosedError       // acquire against draining/destroyed pool — pool's domain
    ├── ClientNotConnectedError   // query fired before client.connect() resolved — see below
    ├── ClientClosedError         // client-domain wrapper of PoolClosedError — see below
    ├── AbortError                // operation aborted via AbortSignal — name='AbortError'
    ├── TimeoutError              // operation aborted via AbortSignal.timeout() — name='TimeoutError'
    └── DriverError               // unexpected driver-internal failure — wraps as `cause`
```

### Standard fields on `MssqlError`

Every `MssqlError` carries the context fields relevant to the object that produced it. The full set:

```ts
class MssqlError extends Error {
  readonly connectionId?: string   // from ADR-0016, when the error was associated with a connection
  readonly queryId?: string        // from ADR-0016, when the error was associated with a request
  readonly poolId?: string         // from ADR-0016, when the error was associated with a pool
  readonly cause?: unknown         // ES2022 native — the native driver/pool error we wrapped
}
```

`cause` is populated using the ES2022 standard `{ cause }` constructor option. Debuggers, logging libraries (pino, winston), and Node's own stack-printing honour it automatically. Users who want to see what tedious / msnodesqlv8 / tarn originally threw follow `.cause` down the chain.

### `QueryError` — server-side request failures

`QueryError` carries the TDS error-token fields verbatim:

```ts
class QueryError extends MssqlError {
  readonly number: number          // T-SQL error number (e.g. 2627 for unique violation)
  readonly state: number           // T-SQL error state
  readonly severity: number        // aka `class` — higher = more serious
  readonly serverName?: string     // server that produced the error
  readonly procName?: string       // stored procedure name, if inside one
  readonly lineNumber?: number     // 1-based line within the batch/proc
}
```

Matching a specific server error is a programmatic check against `.number` — for example, `e instanceof ConstraintError && e.number === 2627` for a duplicate-key violation. We do not mirror SQL Server's error-number space in classes — there are thousands of `sys.messages` entries and any useful taxonomy would need to live in docs, not types. Classes exist where users branch on them *programmatically* and need autocomplete; numbers exist where users branch on the specific code.

The full server message text is preserved on `e.message` (the standard `Error.message` property), so users have everything: `e.message` (server text verbatim), `e.number` / `e.state` / `e.severity` / `e.serverName` / `e.procName` / `e.lineNumber` (structured TDS fields), and `e.cause` (the original driver-thrown error object — tedious's `RequestError`, msnodesqlv8's ODBC error — for anyone who needs the native shape). Drivers do not strip or summarise the server message; it goes through unchanged.

### `ConstraintError` — the one QueryError subclass that earns its keep

Constraint violations are the single query-error category where users routinely want programmatic branching ("insert failed because of a duplicate key → return HTTP 409"). `ConstraintError` extends `QueryError` and adds:

```ts
class ConstraintError extends QueryError {
  readonly kind: 'unique' | 'foreignKey' | 'check' | 'notNull' | 'default'
  readonly constraintName?: string  // parsed from the message if available
}
```

Mapping from T-SQL number → `kind`:

| Number | Meaning | `kind` |
|---|---|---|
| 2627, 2601 | Unique / PK violation | `'unique'` |
| 547 | FK violation | `'foreignKey'` |
| 547 (CHECK path) | CHECK constraint | `'check'` |
| 515 | NOT NULL violation | `'notNull'` |
| 544, 8114 | Default / identity insert | `'default'` |

(Note 547 maps to both `foreignKey` and `check`; the TDS message text disambiguates. Drivers parse it; this is the classic "SQL Server overloads one number" case and is worth the parse.)

`constraintName` is parsed best-effort from the server message — SQL Server's constraint-violation messages include the constraint name in a reasonably stable format. If parsing fails, the field is `undefined`; the user still has `.number` and `.message`.

Other potentially-interesting subclasses (deadlock, timeout-from-server, lock-escalation-failure) are intentionally *not* in v13.0. They can be added later as additive subclasses of `QueryError` without breaking existing `instanceof QueryError` checks.

`MultipleRowsetsError` lives directly under `MssqlError`, not under `QueryError`, because `QueryError`'s TDS fields (`number`, `state`, `severity`) are required on its shape — a server-rejection contract — and `MultipleRowsetsError` is a library-side check with no server error to carry. Users catching `QueryError` get the narrow "server rejected my statement" category with TDS fields reliably populated; the broader category for any query-related failure is `MssqlError` itself.

### `PoolError` — failures in the pool's own domain

`PoolError` covers failures semantically about the pool itself, not about the connection or the query. One subclass in v13.0:

**`PoolClosedError`** — an `acquire()` reached the pool adapter while the pool was draining or destroyed:

```ts
class PoolClosedError extends PoolError {
  readonly state: 'draining' | 'destroyed'
}
```

This is the pool's domain class for shutdown. Consumers never catch it directly — the client's dispatcher wraps it as `ClientClosedError` before it leaves the library boundary (see `ClientClosedError` below). Exported anyway so third-party tooling that inspects the pool directly has something typed to match on.

**Pool adapters do not track their own timeouts.** The contract in [ADR-0011](0011-pool-port.md) is unambiguous: `pool.acquire(signal)` respects the inbound `AbortSignal` as the single cancellation mechanism. A well-behaved adapter propagates signal abort into its own pending work and rejects with the signal's reason, which is translated to `AbortError` / `TimeoutError` at the adapter boundary. Adapters built on libraries with mandatory internal timeouts (tarn's `acquireTimeoutMillis`) configure those to `Infinity` and let the inbound signal be the source of truth. There is no `PoolAcquireTimeoutError` class — pool contention manifests as the consumer's signal firing at `phase: 'pool-acquire'` (see "Phase tracking" below), which is enough to distinguish from connection / query failures.

`driver.open()` failures during pool create-phase surface as `ConnectionError` **unchanged**. Drivers already translate native errors to the core family ([ADR-0010](0010-driver-port.md)), so the pool has nothing to wrap — it lets the error propagate. The pool does not add itself to the error's class hierarchy, does not re-classify, does not construct a new error. Users retrying on `ConnectionError` pick up pool-initiated failures the same way they pick up a direct `client.connect()` failure. If the pool adapter wants to annotate `poolId` onto the propagating error for diagnostic context, that is a simple field set, not a new object.

### Recoverable vs. terminal during acquire

Consumers calling `sql.acquire()` (explicitly, or implicitly via `` sql`...` ``) should receive a healthy connection or a fast, honest error. They should not have to catch and retry transient pool-internal failures — that is the pool's job ([ADR-0011](0011-pool-port.md)). They should also not wait out the full `defaultTimeout` because something unrecoverable happened that the pool silently retried until the clock ran out.

Because hook execution lives inside the pool adapter, "the pool returns a healthy, hook-applied connection or throws" is a single contract. The split:

**Recoverable — handled inside the pool adapter, invisible to the caller:**

- A cached connection turns out to be dead (TCP reset, keepalive missed, driver-level validate fails). The adapter destroys it and retrieves another cached connection, or falls back to creating a fresh one.
- `onAcquire` ([ADR-0011](0011-pool-port.md)) throws — for example, `sql.ping()` fails, or `USE <db>` fails because the just-acquired connection died. The adapter destroys the connection and retries with another cached connection or a fresh one, under its own retry policy. From the consumer's perspective this is still a single logical acquire; retries are internal, bounded by `defaultTimeout` / signal.

In either recoverable case, the consumer never sees a `ConnectionError` from the path. The adapter's internal retries are observable via `mssql:pool:acquire` ([ADR-0014](0014-diagnostics.md)) — the tracingChannel's start/error/asyncEnd timing covers the whole acquire (including any hook execution and any internal retries the adapter performed).

**Terminal — surfaced immediately:**

- `driver.open()` fails during the adapter's create-connection phase. The driver has already produced a `ConnectionError` at its own port boundary ([ADR-0010](0010-driver-port.md)); the adapter lets it propagate unchanged. The consumer learns within one network round-trip that the database is unreachable, rather than waiting out `defaultTimeout`. Adapters that have their own internal create-retry policy (tarn does) perform those retries *within* their configured budget, but once they give up, the error surfaces.
- The pool is draining or destroyed → `PoolClosedError` at the pool boundary, wrapped to `ClientClosedError` by the client dispatcher before reaching the consumer (see below).
- The caller's signal fires → `AbortError` (or `TimeoutError` if the signal's reason is a timeout DOMException), with a `phase` field indicating where in the lifecycle the abort happened (`'pool-acquire'`, `'connect'`, `'dispatch'`, `'response'`, etc. — see "Phase tracking" below). For query-attached acquires, the terminal's tracingChannel publishes the outcome — `asyncEnd` with `reason: 'cancelled'` for `AbortError`, `error` for `TimeoutError` ([ADR-0014](0014-diagnostics.md)); for bare `sql.acquire()`, `mssql:pool:acquire` ends with the same categorisation. Pool contention specifically manifests as `phase: 'pool-acquire'` — distinct from connection or query failures via the phase, not via a separate class.

The load-bearing property is that `ConnectionError` from `sql.acquire()` genuinely means "the database refused or could not be reached right now," not "the pool had a stale connection that I could have silently replaced." Consumers can safely treat `ConnectionError` as a circuit-breaker signal without worrying about false positives from pool internals.

Implementing this split is a port-level requirement on pool adapters: "distinguish validate-failure (retry internally) from create-failure (propagate as-is)." Tarn already has this shape; third-party adapters document their policy in the same terms.

### `ClientNotConnectedError` and `ClientClosedError` — client-lifecycle classes

Two classes correspond to the client's lifecycle states:

```ts
class ClientNotConnectedError extends MssqlError {
  // thrown synchronously when a query fires before client.connect() has resolved
}

class ClientClosedError extends MssqlError {
  readonly state: 'draining' | 'destroyed'
  // cause: the PoolClosedError that was caught at the boundary, preserved for inspection
}
```

`ClientClosedError` is the client-domain wrapper of `PoolClosedError`. The pool's own vocabulary for "I am shut down" is `PoolClosedError`; the client wraps it as it crosses the boundary, so pool-shaped errors don't leak out. Two ways the client's dispatcher produces one:

1. **Fast path (state check).** Before calling `pool.acquire()`, the dispatcher inspects `pool.state` ([ADR-0011](0011-pool-port.md)). If it is `'draining'` or `'destroyed'`, the dispatcher throws `ClientClosedError` synchronously without touching the pool.
2. **Race path (wrap).** A new acquire arrives at the pool in the small race window where `pool.state` was `'open'` at the dispatcher's check but transitioned between check and adapter entry (concurrent `client.close()` or `client.destroy()` from another callsite). The adapter throws `PoolClosedError`; the dispatcher catches and re-throws as `ClientClosedError({ state, cause: poolErr })`.

Drain / destroy semantics — what counts as "in-flight" during a graceful drain, when a `ClientClosedError` is produced versus when the work is allowed to complete, the state model that decides which `state` value lands on the error — are the subject of a separate future ADR on client lifecycle. This ADR records the class identities and the wrap mechanic.

The two-class split respects the domain boundaries: the pool knows about pools (`PoolClosedError` lives in pool-land); the client knows about client lifecycle (`ClientClosedError` lives in client-land). The wrap is cheap — one catch, one re-throw, cause chain preserved. Consumers catch one class (`ClientClosedError`) and get everything.

**`ClientClosedError` is the programmatic answer to [tediousjs/node-mssql#1837](https://github.com/tediousjs/node-mssql/issues/1837).** Where v12 returned tarn's `Error('aborted')` with no stable shape, v13 adapters translate at the port boundary to `PoolClosedError`; the client's dispatcher surfaces it as `ClientClosedError` to consumers.

### `AbortError` and `TimeoutError` — in-family, with the `name` convention preserved

When a consumer's `AbortSignal` fires during any library operation (query execution, acquire, transaction, bulk load — see [ADR-0013](0013-cancellation-and-timeouts.md)), the library produces a core-defined error:

```ts
class AbortError extends MssqlError {
  readonly name = 'AbortError'
  readonly phase: AbortPhase
}

class TimeoutError extends MssqlError {
  readonly name = 'TimeoutError'
  readonly phase: AbortPhase
}

type AbortPhase =
  | 'pool-acquire'         // waiting for the pool to give us a connection (queueing or onAcquire hook)
  | 'connect'              // driver opening a fresh connection (TCP + TDS login)
  | 'dispatch'             // request being sent to the server
  | 'response'             // request sent, awaiting / receiving the response stream
  | 'transaction-begin'
  | 'transaction-commit'
  | 'transaction-rollback'
  | 'savepoint'
  | 'rollback-to-savepoint'
  | 'prepare'
  | 'unprepare'
```

**Phase tracking.** The `phase` field captures *where in the request lifecycle* the abort fired. This matters for retry policy and for debugging: `phase: 'pool-acquire'` says "the pool was saturated or its acquire was waiting" (retry is usually safe — no work has hit the server); `phase: 'response'` says "the server has accepted the request and may be doing work" (retry is idempotency-sensitive); `phase: 'dispatch'` says "the request was being sent" (the server may or may not have started executing). The phase taxonomy is a kernel-level concern — the kernel knows which orchestration step it was on when the abort fired and stamps it onto the error before throwing. The same value is also surfaced on the diagnostics channel ([ADR-0014](0014-diagnostics.md)) — on the `error` channel's published `TimeoutError` for timeouts, or on the `asyncEnd` context's `phase` field for cancellations — so log-and-trace consumers see identical data to catch-site code.

The `name` property is how the Node / WebAPI ecosystem (`fetch`, `undici`, `AbortSignal.timeout()`, …) distinguishes abort and timeout — it is duck-typing, not an `instanceof` check against `DOMException`. Setting `name` on our classes makes `err.name === 'AbortError'` work exactly as it would for a standard `DOMException`, and at the same time gives us:

- `err instanceof MssqlError` — uniform library catch.
- `err instanceof AbortError` — specific match for consumers importing the class.
- `err.connectionId` / `err.queryId` / `err.cause` — contextual fields at the catch site without reaching for the diagnostics channel.

The two schemes compose; there is no ergonomic cost to being in-family because the name property covers the ecosystem convention.

The choice of which class to construct maps straight from `signal.reason`: a `DOMException` named `'TimeoutError'` (what `AbortSignal.timeout()` produces) becomes a `TimeoutError`; anything else becomes an `AbortError`. The original `signal.reason` is preserved on `.cause`, so consumers walking the chain see the DOMException they are used to.

The diagnostics surface preserves the same `signal.reason` value: for cancellations the `AbortError` published on `asyncEnd`'s `error` field carries `.cause` set to `signal.reason`; for timeouts the `TimeoutError` published on the `error` channel carries `.cause` set to `signal.reason` ([ADR-0014](0014-diagnostics.md)). Catch-site consumers and diagnostics subscribers walk the same `.cause` chain to see the raw `DOMException` produced by `AbortSignal.timeout()` / `controller.abort()` (or any value the consumer passed to `controller.abort(x)`). The library does not duplicate this onto a separate diagnostics field — the cause chain on the published error is the canonical source.

### Translation at the port boundaries

**Driver boundary ([ADR-0010](0010-driver-port.md)).** Every driver throws `MssqlError`-family errors. No tedious `RequestError`, no msnodesqlv8 ODBC error, no raw `Error` escapes the driver. Drivers wrap the native error as `.cause` and set the appropriate subclass + fields. For example, `@tediousjs/mssql-tedious` maps tedious's `RequestError` with `number: 2627` → `new ConstraintError({ number, state, severity, kind: 'unique', constraintName, cause: tediousError })`.

**Pool boundary ([ADR-0011](0011-pool-port.md)).** Every pool adapter throws `MssqlError`-family errors at the port boundary. Errors already in the family (e.g. the `ConnectionError` from `driver.open()`) pass through untouched — no re-wrapping. Native pool-library errors are translated. `@tediousjs/mssql-tarn`:

| Source | Core error |
|---|---|
| Consumer's `AbortSignal` fired (reason: `'AbortError'`) — adapter propagates abort into tarn | `AbortError({ cause: signal.reason, phase })` |
| Consumer's `AbortSignal` fired (reason: `'TimeoutError'`, e.g. `AbortSignal.timeout()`) | `TimeoutError({ cause: signal.reason, phase })` |
| Tarn's `Error('aborted')` during teardown | `PoolClosedError({ state: poolState, cause })` |
| `ConnectionError` from `driver.open()` | *propagates unchanged* (optionally annotated with `poolId`) |

Tarn is configured with `acquireTimeoutMillis: Infinity` so its internal timeout never fires; the inbound `AbortSignal` is the single cancellation source. Third-party pool adapters follow the same discipline — the `Pool` port's contract ([ADR-0011](0011-pool-port.md)) is "do not track your own timeouts; respect the inbound `AbortSignal`; translate native pool-library errors into the core family; propagate in-family errors from the driver unchanged."

`SingleConnection` (the no-pool short-circuit) naturally throws core-family errors already because it has no native pool library underneath. Its cancellation is signal-driven.

### `DriverError` — the wrapper of last resort

`DriverError` exists for unexpected failures the driver could not confidently classify — a malformed protocol frame, an unknown error number, a panic the driver caught while shutting down. It always has `.cause` populated. Users catching `MssqlError` catch it; users wanting to log-and-continue inspect `.cause`.

A `DriverError` in production is a bug report: the driver should have classified it into a more specific subclass. Presence is monitored via `mssql:connection:error` ([ADR-0014](0014-diagnostics.md)).

### Cause chain

ES2022 `{ cause }` is native, preserved across `throw` / `await`, and printed by Node's default error formatter — users walking the chain inspect the wrapped error (e.g. `e.cause?.code === 'ECONNRESET'` on a wrapped `ConnectionError`). We do not reinvent `.originalError` or `.inner` — `cause` is standard. Documentation points at it explicitly because users coming from older Node codebases may not have internalised it.

## Consequences

- Users have one taxonomy to learn. `instanceof MssqlError` catches everything the library produces — *including* abort and timeout, which are now in-family. `err.name === 'AbortError'` duck-typing still works for ecosystem code that already uses it.
- #1837 closes: `ClientClosedError` is the programmatic answer consumers catch at the client boundary. The pool's internal `PoolClosedError` carries the same information in pool-domain vocabulary and is preserved on `.cause`.
- Domain separation holds: the pool produces pool-shaped errors (`PoolError` and subclasses); the client wraps those as needed for client-shaped errors (`ClientClosedError`). Neither layer reaches across the boundary to construct the other's classes.
- Client state is a read of pool state — one source of truth. The dispatcher's fast path inspects `pool.state`; the race path catches `PoolClosedError` and wraps. Consumers catching `ClientClosedError` know with certainty the client itself is the thing that rejected, not the database.
- Pool-contention manifests as the consumer's signal firing at `phase: 'pool-acquire'` — distinguishable from connection / query failures via the phase, not via a separate class. Adapters built on libraries with mandatory internal timeouts (tarn) configure those to `Infinity` and let the inbound signal own cancellation.
- The pool port contract is "signal-driven cancellation only." All pool adapters honour the inbound `AbortSignal` and produce `AbortError` / `TimeoutError` derived from `signal.reason`. No adapter-internal timeout escapes as its own error class.
- The terminal's tracingChannel covers acquire-phase aborts for query-attached operations — a consumer subscribing to `asyncEnd` (cancellations) and `error` (timeouts and genuine errors) sees pool cancellations uniformly with query cancellations, because the mechanism is the same `AbortSignal` and the categorisation is by `signal.reason.name`.
- Class identity is load-bearing. `@tediousjs/mssql-core` is the single source of truth ([ADR-0004](0004-monorepo-layout.md)); peer-dep discipline keeps `instanceof` working across every driver and pool adapter.
- Drivers and pool adapters carry a translation responsibility, but only for errors originating in their own domain. Drivers translate native driver errors; pools translate native pool-library errors. Neither re-wraps errors already in the core family. In particular, `driver.open()`'s `ConnectionError` propagates through the pool unchanged.
- Abort and timeout errors carry `connectionId` / `queryId` directly because they are `MssqlError` subclasses. Users who previously had to dig these out of diagnostics channels have them on the error now.
- `ConstraintError` with 547 requires message-text parsing to distinguish FK from CHECK. The parse is best-effort; a driver that fails to parse falls back to `kind: 'check'` and the user can still branch on `.number`.
- `DriverError` is the wrapper of last resort. A well-tuned driver should produce it rarely; its rate is a driver-quality metric.
- The taxonomy is intentionally shallow. Deeper subclasses (deadlock, lock-escalation, foreign-key-cascade-null-set, etc.) can be added later as additive non-breaking changes.

## Alternatives considered

**Flat error class with everything in fields (`MssqlError` + `.kind: 'connection' | 'query' | ...`).** Rejected. Users can't autocomplete against a string discriminator the way they can against `instanceof` subclasses, and adding a new kind is a breaking change for exhaustive-match callers who use TypeScript's `never` checking.

**Mirror SQL Server's error-number space in classes (`DuplicateKeyError`, `CheckConstraintError`, `LockEscalationError`, ...).** Rejected. `sys.messages` has thousands of entries; the library would be maintaining a taxonomy that's more exhaustive than any user needs. Users who *do* need specific numbers branch on `.number`. `ConstraintError`'s five-way `kind` split is the one place the class-vs-number trade-off flipped toward classes because constraint-based branching is extremely common application logic.

**Keep `AbortError` / `TimeoutError` out of the `MssqlError` family (propagate raw `DOMException`).** Previously drafted. Rejected on a later iteration because `err.name === 'AbortError'` is duck-typing against a property, not an `instanceof DOMException` check. A class that sets `name = 'AbortError'` satisfies the ecosystem convention *and* extends `MssqlError` at the same time — the two schemes compose, there is no either/or. Bringing them into the family gives users `connectionId` / `queryId` / `cause` on the error itself, and a single `instanceof MssqlError` catch for everything the library throws.

**Classes in each driver/pool package, not centralised in core.** Rejected. This was implicitly v12's model and is exactly why `instanceof` doesn't work across the boundary. Centralising in core + peer-dep drivers is the load-bearing fix.

**`.originalError` / `.inner` instead of `cause`.** Rejected — `cause` is ES2022 standard, understood by Node's error printer, jest, pino, winston, and every APM we care about. Reinventing it is pure cost.

**`PoolError` with a `reason` field instead of subclasses.** Considered because `reason` fields are the pattern on tracingChannel `asyncEnd` for cancellations ([ADR-0014](0014-diagnostics.md)). Rejected for the small subclass set we have: `instanceof ClientClosedError` is more ergonomic at the catch site than `err instanceof PoolError && err.reason === 'closed'`. Reason-like fields stay inside subclasses (e.g. `ClientClosedError.state`) for further discrimination within a category.

**Classify pool-during-acquire connection failures as `PoolError`.** Considered. Rejected because the semantic category of the error is "couldn't reach the database," which is a connection concern. Users retrying on connection errors want uniform handling regardless of whether the pool or a direct `sql.acquire()` triggered the open. The driver already produces `ConnectionError`; the pool lets it propagate unchanged. (The previous iteration had the pool "wrap" the driver's error to add `poolId`; that was over-engineering — drivers already produce core-family errors, so there is nothing to wrap.)

**Have the pool re-wrap `driver.open()` failures to add pool context.** Rejected because drivers are already contractually obliged to produce `MssqlError`-family errors ([ADR-0010](0010-driver-port.md)). Re-wrapping constructs a new object, disturbs the `.cause` chain, and makes `instanceof ConnectionError` checks unreliable across the pool boundary for no benefit. If the adapter wants to annotate `poolId` on the propagating error for diagnostic context, a field assignment does the job — no new class, no new identity.

**Let pool adapters own their own acquire timeouts (no `AbortSignal` contract).** Rejected because it leaves cancellation fragmented: `defaultTimeout` would have to layer a separate timer for pool acquire vs. query execution, adapters would invent their own timeout knobs, and consumers would have two cancellation mechanisms to reason about. The single-signal model unifies cancellation — the signal is the source of truth, the terminal's tracingChannel publishes outcomes uniformly (`asyncEnd` for cancellations, `error` for timeouts), and the pool adapter's only responsibility is to honour it. Adapters built on libraries with mandatory internal timeouts (tarn) configure those to `Infinity`; the inbound signal owns cancellation end-to-end.

**Add `PoolAcquireTimeoutError` to distinguish pool contention from other timeouts.** Considered in an earlier draft as a tarn-specific carve-out. Rejected once we standardised on "tarn configured with `acquireTimeoutMillis: Infinity`, signal owns cancellation." Pool contention is now expressed as a `TimeoutError` (or `AbortError`) with `phase: 'pool-acquire'`, which is the uniform signal/phase model rather than a special class. A user debugging "is my pool saturated?" inspects `phase` (and consults `pool.stats` for the deeper view), distinguishing it from connection failures (`ConnectionError`) or query failures (`QueryError`) without a third class. Less surface, same ergonomic outcome.

**Unify `ClientClosedError` and `PoolClosedError` into one class.** Considered and previously drafted. Rejected because it required the pool adapter to construct a client-domain error class (`ClientClosedError`), which leaks the client concept into the pool layer. Keeping the two classes separate — each native to its own domain — respects the layering, and the wrap is a single catch-and-rethrow with the cause chain preserved. Consumers still only ever catch one class (`ClientClosedError`); the separation is invisible to them.

**Skip an `opening` state on the grounds that there's no async startup window.** Considered in an earlier draft. Reversed once `client.connect()` was specified as the eager-validation entry point — there *is* an async startup window, and gating queries on it is exactly what `ClientNotConnectedError` does. Whether the pool itself exposes an `'opening'` state, or whether the gating stays as a client-level concept layered on top of `pool.state`, is a follow-up question for [ADR-0011](0011-pool-port.md). The error taxonomy in this ADR works either way: pre-connect query → `ClientNotConnectedError`; failure during `connect()` → `ConnectionError` on the Promise. Earlier drafts that argued "no async window exists" were incorrect.

**Let the shutdown check be a runtime assertion without a class.** Rejected because without a distinct class, consumers catching errors during shutdown cannot distinguish "client is gone" from "database is gone" without inspecting `.message` strings — exactly the v12 anti-pattern this ADR is fixing. One class, one `instanceof`, one branch.

**Ship `DeadlockError`, `TimeoutFromServerError` (the 1222 code), etc. in v13.0.** Considered. Deferred. These are genuinely useful but can land as additive subclasses of `QueryError` later without breaking existing catches. v13.0 ships the five-way `ConstraintError.kind` because that is the one category with clear evidence of routine application-level branching.

## References

- [ADR-0004: Monorepo layout](0004-monorepo-layout.md) — peer-dep discipline that keeps `instanceof` identity intact.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — home of `MultipleRowsetsError`.
- [ADR-0010: Driver port](0010-driver-port.md) — translation boundary on the driver side.
- [ADR-0011: Pool port](0011-pool-port.md) — translation boundary on the pool side.
- [ADR-0012: Credential and Transport](0012-credential-and-transport.md) — home of `CredentialError`.
- [ADR-0013: Cancellation and timeouts](0013-cancellation-and-timeouts.md) — source of `AbortError` / `TimeoutError` semantics.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — terminal tracingChannel `asyncEnd` (cancellations) and `error` (timeouts / genuine errors) / `mssql:pool:acquire` carry IDs, phase, and cause context uniformly for query- and acquire-phase outcomes.
- [ADR-0016: Object ID format](0016-object-id-format.md) — `connectionId`, `queryId`, `poolId` fields on every error.
- [ADR-0018: Client lifecycle](0018-client-lifecycle.md) — `connect` / `close` / `destroy` semantics that determine which `state` value lands on `ClientClosedError`, and where `ClientNotConnectedError` is thrown.
- [tediousjs/node-mssql#1837](https://github.com/tediousjs/node-mssql/issues/1837) — unclassifiable tarn aborts; the motivating case for `ClientClosedError`.
- [Vincit/tarn.js#83](https://github.com/Vincit/tarn.js/issues/83) — upstream proposal for `TarnError`; we do not depend on this landing because we translate at the adapter boundary.
- [ES2022 error cause](https://tc39.es/proposal-error-cause/) — the `{ cause }` constructor option used throughout.
