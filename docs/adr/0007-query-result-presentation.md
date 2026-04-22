# ADR-0007: Query result presentation — column metadata, raw rows, duplicates, trailer data, and side channels

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

[ADR-0006](0006-queryable-api.md) settles the top-level shape of the queryable API: one callable, a `Query<T>` that is both `PromiseLike<T[]>` and `AsyncIterable<T>`, and a small set of cardinality-named terminals. That decision deliberately leaves several presentation questions open:

- How are column names exposed, and how do callers reach for positional rather than object rows?
- How is trailer data — row counts, output parameters, return status, and the messages SQL Server sends alongside rows — surfaced uniformly across terminals?
- What happens when a SELECT contains duplicate column names — the long-running [#1384](https://github.com/tediousjs/node-mssql/issues/1384) interop question?
- SQL Server's three side-channel message kinds (info / print / envChange) need a clear consumer story without dragging in a per-`Query` `EventEmitter` whose lifecycle is hard to keep coherent across re-executable templates.

## Decision

### `.raw()` and `.columns()` semantics

`.raw()` is a **view toggle**, not a cardinality terminal. It returns a new `Query<R[]>` whose rows arrive as positional tuples instead of objects, in the order reported by `.columns()`. Every other terminal — `.all()`, `.iterate()`, the default `await` / `for await`, `.run()`, `.rowsets()`, `.meta()` — works identically on the raw-mode query, so `await q.raw()`, `for await (const row of q.raw())`, and `await q.raw().rowsets()` all make sense. The tuple element type defaults to `unknown[]`; callers who know the column order can narrow with a tuple type argument, `q.raw<[number, string, Date]>()`.

```ts
// Object rows (default) — last-wins on duplicate column names.
const rows = await sql`select a.id, b.id from a join b on a.x = b.x`

// Raw rows — every column preserved in SELECT-list order.
const pairs = await sql`select a.id, b.id from a join b on a.x = b.x`.raw<[number, number]>()
const cols = await sql`select a.id, b.id from a join b on a.x = b.x`.columns()
// cols[0].name === 'id' ; cols[1].name === 'id'
```

`.columns()` resolves at the first metadata signal from the driver — as soon as the column shape for the first rowset is known. The resolved value is an array of `ColumnMeta` descriptors — name, type, nullability, precision / scale, collation where applicable — one per column in the first rowset.

**`q.columns()` is locked to the first rowset and does not track iteration progress.** The Promise is captured once at the first metadata token and returned identically thereafter — even when the underlying stream advances through subsequent rowsets. For per-rowset metadata in multi-rowset queries, use the rowset's own `.columns()` accessor:

```ts
const q = sql`SELECT a FROM t1; SELECT b FROM t2`
for await (const rowset of q.rowsets()) {
  const cols = await rowset.columns()   // rowset 1: t1's columns; rowset 2: t2's columns
  for await (const row of rowset) { ... }
}
```

The top-level `q.columns()` answers "what shape is the first rowset?" — captured once, returned forever. `rowset.columns()` answers "what shape is *this* rowset?" — one accessor per yielded rowset, each captured at its own metadata boundary. They are distinct accessors with distinct lifetimes; multi-rowset iteration code should reach for `rowset.columns()`, not `q.columns()`.

Edge cases for `q.columns()`:

- **No rowsets** (pure DML, no SELECT): resolves to `[]` when the stream terminates without ever delivering a metadata token.
- **Stream errors before any metadata**: rejects with the same error the row-consuming terminal would surface.
- **Concurrent with `.rowsets()` iteration**: resolves at the first metadata token, observed alongside iteration without competing for the stream.

**`.columns()` kicks off execution.** If no other terminal has fired yet, calling `.columns()` starts the request: the library acquires a connection, sends the statement, and resolves `.columns()` as soon as metadata arrives. With no row-consuming terminal pulling rows, the driver applies standard backpressure — rows queue in a bounded driver-internal buffer up to its watermark, then the wire stops draining. This is the same backpressure mechanism that keeps memory bounded when a `for await` loop's body is slow; the `.columns()`-only case is just the extreme where the consumer reads at zero rows/second. The buffer is small but non-zero — bytes between the metadata signal and the backpressure window stay in driver memory until disposal — and the kernel does not need to know about pausing one way or the other. If the caller never fires a row-consuming terminal, `.dispose()` cancels the request and the connection returns to the pool. The trade-off for letting `.columns()` run before consumption is: you learn the shape eagerly, but you must either consume or dispose to release the connection.

Running shape-introspection terminals alongside a row-consuming terminal is supported — `.columns()` resolves at metadata arrival while `.all()` / `.iterate()` continues to drain rows, both observing the same underlying stream. What still throws is *re-consuming* the same Query: once a consuming terminal has fired and the stream has drained (or errored), a second `.all()` / `.iterate()` / `.raw()` on the same Query throws. `.columns()` may be awaited repeatedly and returns the same resolved value; `.meta()` is a sync getter on terminated-stream state and can be called any number of times after the stream has terminated.

### Trailer data: `q.meta()`

Every response carries trailer data alongside the rows — per-statement row counts, info / print / envchange messages, and (for procedures) output parameters and a return status. This trailer is the same regardless of which terminal consumed the rowset(s), so `Query<T>` exposes it universally:

```ts
const q = sql`update t set x = 1 where id = ${id}`
const rows = await q                             // T[] — probably empty for UPDATE
const { rowsAffected, info } = q.meta()          // trailer — sync getter after the await
```

```ts
interface QueryMeta<O = Record<string, never>> {
  rowsAffected: number                   // sum across all statements in the request
  rowsAffectedPerStatement: number[]     // one entry per statement in the request
  info: InfoMessage[]                    // severity ≤ 10 non-print server messages
  print: string[]                        // T-SQL PRINT output + RAISERROR severity 0
  envChanges: EnvChange[]                // session-level state changes, in arrival order
  output: O                              // stored-proc output params; {} for raw queries
  returnValue: number | undefined        // procedure return status; undefined for non-procs
  completed: boolean                     // true iff the stream drained naturally
  cancellation?: {
    reason:
      | 'user-abort'              // AbortSignal passed via .signal()
      | 'default-timeout'         // the wall-clock defaultTimeout fired on a buffered terminal
      | 'early-terminate'         // library-initiated — for-await break / return / throw, or dispose at scope exit
      | 'error'                   // server or driver error mid-stream
    error?: Error
  }
}
```

Semantics:

- `q.meta()` is a **synchronous getter** — it returns `QueryMeta<O>` directly, reading trailer state collected by the terminal as the stream drained. The natural sequence is `await` the row-consuming terminal first, then read meta:
  ```ts
  const rows = await q.all()
  const meta = q.meta()
  ```
- `q.meta()` throws `TypeError` if **the stream has not yet terminated** — no terminal has fired, or a terminal has fired but the stream is still draining. The exception fires synchronously at the call site, so the stack trace points at the misuse. Inside a `for await` loop, calling `meta()` mid-loop throws (the stream has not terminated until the loop completes). This matches the broader JS pattern of sync state-inspection on async-collected data — `Response.headers`, `xhr.getAllResponseHeaders()`, Node streams' `readableEnded`.
- On cancellation (`AbortSignal`, iterator `return()`, early termination, error mid-stream), the stream terminates and meta state is populated with `completed: false` and `cancellation` set. Inside the catch block (or after the iterator throws), `q.meta()` returns synchronously with this data — useful for "what info messages did I get before the abort?" debugging.
- Inline `` await sql`...` `` users who discard the `Query` reference lose access to meta. That is the expected trade-off for the one-liner ergonomics; holding the reference is one extra line.
- Live, per-query mid-stream message access is not first-class in v13.0 — see §Info messages.
- Typing flows from the query source: the procedure builder parameterises `O` from its `.output()` / `.inout()` declarations, so `q.meta().output.x` is typed without the user having to restate it at the call site.

### Duplicate column names — last-wins, with `.raw()` as the escape hatch

SQL Server permits duplicate column names in a rowset (`SELECT a.id, b.id FROM a JOIN b ...`). When row-mapping terminals (`.all`, `.iterate<T>`, default `await` / `for await`) encounter duplicates, v13 collapses them **last-wins**: the object handed back carries only the final value for each name. This matches the default behaviour of `pg`, `mysql2`, Knex, Prisma, and every ORM built on that stack, and it is the behaviour TypeScript typing for `T` already assumes (one property per name).

This is a deliberate change from v12, which returned duplicate values as an array (`{ id: [1, 2] }`). The v12 behaviour preserved every value but disagreed with the rest of the ecosystem, making mssql the odd driver out for query-builder and ORM integrations ([tediousjs/node-mssql#1384](https://github.com/tediousjs/node-mssql/issues/1384)). v13 picks interoperability.

When every value matters, `.raw()` is the v13.0 escape hatch: rows arrive as positional tuples, so duplicates are preserved by index, and `.columns()` gives the name + type for each slot. This ships in v13.0 because `.raw()` exists for the unrelated "give me array rows" use case anyway — duplicate-column preservation falls out as a natural property, not an extra API surface.

```ts
// Last-wins: the b.id value overwrites a.id under the same key.
const rows = await sql`select a.id, b.id from a join b on a.x = b.x`
// rows[0] is { id: <b.id value> }

// Preserved: every value lands in its own position.
const cols = await sql`select a.id, b.id from a join b on a.x = b.x`.columns()
const pairs = await sql`select a.id, b.id from a join b on a.x = b.x`.raw<[number, number]>()
// pairs[0] is [<a.id>, <b.id>] ; cols[0].name === cols[1].name === 'id'
```

The SQL-side fix remains explicit aliasing (`SELECT a.id AS a_id, b.id AS b_id`) for cases where the caller controls the SELECT. `.raw()` is for the cases where they do not — generated SQL, query builders, or code that needs to survive unknown-shape rowsets. A `diagnostics_channel` event for silently-collapsed duplicates may still land in a later v13 minor as a debugging aid, separate from the preservation question, which `.raw()` now answers. #1384 is the tracking anchor.

### Info messages, PRINT, and warnings

SQL Server sends three kinds of side-channel messages during a request:

- **info** — severity ≤ 10 non-print messages (truncation warnings, deprecation notices, `sys.messages` informational entries).
- **print** — T-SQL `PRINT` output and `RAISERROR` with severity 0. Often used for procedural debug.
- **envChange** — session-level state changes the driver reports (database, language, collation, packet size, isolation level). The pool does not react to these; consumers who need state consistency when a connection is returned to the pool configure a client-level `onRelease` hook, not automatic invalidation.

These three are kept separate because they have different meanings and different consumer needs; mssql v12 collapses the first two into a single `info` event which is a downgrade we do not want to carry forward.

Two paths cover two different consumer shapes in v13.0:

1. **Per-query, post-drain via `q.meta()`** — `info`, `print`, `envChanges` arrays on the trailer object, populated by the time the stream drains. This is the path users reach for when they want to see what messages came back from *this* query. First-class.
2. **Cross-cutting via `diagnostics_channel`** — `mssql:request:info`, `mssql:request:print`, `mssql:request:env-change` publish globally for every request, regardless of listener registration, for APM integration and for structured logging across all queries. The right tool for "log every PRINT my service ever emits" or "feed every info message into the tracing span."

```ts
// Per-query: collected from meta() after drain.
const q = sql`exec sp_debug_report`
const rows = await q.all()
const meta = q.meta()
meta.print.forEach(msg => log(msg))
```

**Live, per-query mid-stream message access is not first-class in v13.0.** There is no public Query identifier or supported correlation pattern that would let a `diagnostics_channel` subscriber filter to a specific query — using `diagnostics_channel` that way is an anti-pattern. The narrow band where this matters (live PRINT progress on a long migration, interactive debug-proc output) is deferred until real demand emerges and the listener-lifecycle interaction with re-executable templates is designed. See Alternatives Considered.

**Promote-to-error policy** at the client level, predicate form so the threshold is user-chosen:

```ts
createClient({
  errorOnInfo: (msg) => msg.class >= 11 || msg.number === 2628,   // 2628 = string truncation
})
```

When the predicate returns `true`, core throws a `QueryError` at the point in the stream where the info would have been emitted. Rails' `strict_loading` and SQLAlchemy's `filterwarnings('error', SAWarning)` establish this as a familiar pattern; doing it at library level is a genuine win because T-SQL's severity/number system gives us a natural threshold that generic warning-promotion frameworks do not.

## Consequences

- Trailer data (row counts, info, print, envChange, output parameters, return value) is uniformly available via `q.meta()` regardless of which terminal consumed the rows. The inline-await pattern (`` await sql`...` ``) discards the `Query` reference and forgoes meta — that is the price of the one-liner, not a hidden cost.
- `.raw()` covers two unrelated needs with one API surface: positional rows for tuple-typed callers, and full preservation of duplicate column names. v12's array-valued duplicate behaviour is dropped in favour of last-wins (matching the pg / mysql2 / ORM ecosystem default), and `.raw()` + `.columns()` is the preservation path for users who need every value ([#1384](https://github.com/tediousjs/node-mssql/issues/1384)).
- `.columns()` resolves before rows are pulled. The driver's standard backpressure keeps memory bounded when no row-consuming terminal is reading — rows queue up to a watermark, then the wire stops draining; the kernel and consumers are agnostic to whether the wire is currently paused. Users who only want the shape pay a small bounded driver-buffer's worth of memory until they call `.dispose()`; users who want both shape and rows pay nothing extra (the buffer drains naturally as they consume).
- Side-channel data (info / print / envChange) is exposed two ways: per-query, post-drain via `q.meta()` (the default path), and cross-cutting / global via `diagnostics_channel` for APM and structured logging across all queries. v13.0 deliberately does not ship a first-class **live, per-query** path — no public Query identifier, no encouragement to use `diagnostics_channel` for per-query filtering (which would be an anti-pattern). Adding a live-per-query surface later is non-breaking.
- The `errorOnInfo` predicate gives users a SQL-Server-aware promote-to-error policy without a generic warning framework on top — the predicate sees the full `InfoMessage` (class, number, message, procName, lineNumber) and decides per call.

## Alternatives considered

**Per-`Query` `EventEmitter` for live `info` / `print` / `envChange` events.** Considered for the inline ergonomics — `q.on('print', cb)` reads naturally next to `for await (const row of q)`, and Node's `EventEmitter` is the standard observer surface. Deferred to a later v13 minor. The listener-lifecycle story does not survive contact with re-executable templates: `Procedure` and `PreparedStatement` extend `Query<T>` but a "terminal" on them ends a single round-trip, not the object's life — clearing listeners on terminal forces re-registration after every execute, persisting them violates the leak-prevention story raw queries need, and giving the subtypes different listener semantics from the parent makes the inheritance lie. v13.0 ships `q.meta()` as the per-query path (post-drain) and `diagnostics_channel` as the cross-cutting global path; the *live, per-query* band is genuinely narrow and not yet validated by demand. We do not steer users toward `diagnostics_channel` for per-query filtering — that would require a public Query identifier and a correlation pattern we have not designed, and using a global telemetry channel for per-instance observation is the wrong tool for the job. The chained `.onInfo(cb)` / `.onPrint(cb)` shape is deferred for the same reason — it is an alternative spelling of the same surface.

**Explicit socket-level pause/resume on `.columns()`-only consumption.** Considered. An earlier draft had drivers expose `pause()` / `resume()` operations so that `.columns()` could explicitly halt the wire after metadata arrived, before any rows entered driver memory. Rejected because backpressure is already needed for the slow-consumer case (a `for await` body that processes rows slowly, a streaming pipeline with downstream pressure), and the `.columns()`-only case is just an extreme of "consumer reads at zero rows/sec." A separate explicit pause/resume operation pair would double the surface for no gain — backpressure handles both. Some rows still buffer in driver memory before the wire stops draining, but that buffering is unavoidable: between "decide to pause" and "pause takes effect" there's always a window of in-flight bytes regardless of mechanism. Letting backpressure handle it keeps the driver port surface smaller (no `pause()` / `resume()` methods needed) and the `.columns()` consumer agnostic to whether anyone is reading rows.

**Async `q.meta()` that waits for stream termination (`Promise<QueryMeta<O>>`).** Considered for the `Promise.all([q.all(), q.meta()])` parallel-await ergonomic — both promises resolve in one expression. Rejected for several reasons. The parallelism is illusory: only the terminal does work, `meta()` just observes the same stream's termination, so an async return type misrepresents the model. Making the order-of-evaluation in `Promise.all([q.meta(), q.all()])` work would require a microtask-deferred internal check, introducing observable behaviour tied to the deferral primitive (microtask vs macrotask). Calling `meta()` mid-`for await` would silently hang for the duration of the loop rather than throwing immediately. The "you forgot a terminal" footgun would surface as a deferred promise rejection rather than a synchronous stack trace pointing at the misuse. The chosen sync-getter design follows the JS pattern for state-inspection of async work — `Response.headers`, `xhr.getAllResponseHeaders()`, Node streams' `readableEnded` — and the only ergonomic loss is `Promise.all([q.all(), q.meta()])` becoming two lines, which is a fair trade for halving implementation complexity.

**Put trailer data in each terminal's return shape (no universal `.meta()`).** An earlier draft had `.run()` return `{ rowsAffected, info, print, envChanges }` with `.all()` / `.iterate()` having no meta access at all. Rejected — trailer data is delivered alongside every response (the server sends row counts, info / print / envchange messages, and procedure output parameters as part of completing the request), so gating it behind specific terminals is hiding information the server already paid to send. `q.meta()` as a universal accessor means every consumption path can reach `rowsAffected` without switching terminals. The specific terminals that *do* include meta in their return shape (`.run()`) are retained as convenience shortcuts, not as the sole access path.

**Preserve v12's array-valued duplicate columns (`{ id: [1, 2] }`).** Rejected. It preserves data but disagrees with every other driver in the ecosystem, which is exactly the incompatibility [#1384](https://github.com/tediousjs/node-mssql/issues/1384) raises. The TypeScript typing for `T` already assumes one property per name, so keeping arrays forces a permanent split between what the types say and what runtime delivers. `.raw()` + `.columns()` is the preservation path for users who need it — ships in v13.0 alongside the default.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parent decision; terminal set this ADR builds on.
- [tediousjs/node-mssql#1384](https://github.com/tediousjs/node-mssql/issues/1384) — duplicate column names; v13 switches to last-wins, `.raw()` is the escape hatch.
