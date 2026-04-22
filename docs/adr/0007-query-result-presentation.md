# ADR-0007: Query result presentation — column metadata, raw rows, duplicates, trailer data, and side channels

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

[ADR-0006](0006-queryable-api.md) settles the top-level shape of the queryable API: one callable, a `Query<T>` that is both `PromiseLike<T[]>` and `AsyncIterable<T>`, and a small set of cardinality-named terminals. That decision deliberately leaves several presentation questions open:

- How are column names exposed, and how do callers reach for positional rather than object rows?
- How is trailer data — row counts, output parameters, return status, and the messages SQL Server sends alongside rows — surfaced uniformly across terminals?
- What happens when a SELECT contains duplicate column names — the long-running [#1384](https://github.com/tediousjs/node-mssql/issues/1384) interop question?
- SQL Server's three side-channel message kinds (info / print / envChange) need a clear consumer story without dragging in a per-`Query` `EventEmitter` whose lifecycle is hard to keep coherent across re-executable templates.

This ADR records the answers. It is a child of ADR-0006 and assumes its terminal set as given.

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

`.columns()` resolves at the first metadata signal from the driver — as soon as the column shape for the first rowset is known. The resolved value is an array of `ColumnMeta` descriptors — name, type, nullability, precision / scale, collation where applicable — one per column in the first rowset. For multi-rowset responses, `.rowsets()` yields rowset values that each carry their own `.columns()`; the top-level `Query.columns()` reflects the first rowset only.

**`.columns()` kicks off execution.** If no other terminal has fired yet, calling `.columns()` starts the request: the library acquires a connection, sends the statement, and resolves `.columns()` as soon as metadata arrives. To avoid pulling megabytes of rows the caller has not asked for, the driver then **pauses the underlying socket** — tedious exposes `connection.socket.pause()` / `.resume()`, msnodesqlv8 has an equivalent — so the server-side buffer backs up until a row-consuming terminal (`.all()`, `.iterate()`, `.run()`, `.raw()`, `.rowsets()`) resumes it. If the caller never fires a consuming terminal, `.dispose()` on the Query asks the driver to cancel the paused stream (see [ADR-0008](0008-query-lifecycle-and-disposal.md)) — O(1) network bytes rather than draining megabytes the caller has already declined. This is the trade-off for letting `.columns()` run before consumption: you learn the shape eagerly, but you must either consume or dispose.

Running terminals concurrently on the same Query is supported — the common pattern is `const [rows, meta] = await Promise.all([q.all(), q.meta()])` — because all terminals drive the same underlying stream. What still throws is *re-consuming* the same Query: once a consuming terminal has fired and the stream has drained (or errored), a second `.all()` / `.iterate()` / `.raw()` on the same Query throws. `.columns()` and `.meta()` may be called repeatedly and return the same resolved value.

### Trailer data: `q.meta()`

Every response carries trailer data alongside the rows — per-statement row counts, info / print / envchange messages, and (for procedures) output parameters and a return status. This trailer is the same regardless of which terminal consumed the rowset(s), so `Query<T>` exposes it universally:

```ts
const q = sql`update t set x = 1 where id = ${id}`
const rows = await q                             // T[] — probably empty for UPDATE
const { rowsAffected, info } = await q.meta()    // trailer — await the promise
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
      | 'response-start-timeout'  // the single defaultTimeout fired before first byte — ADR-0013
      | 'early-terminate'         // library-initiated — for-await break / return / throw, or dispose at scope exit
      | 'error'                   // server or driver error mid-stream
    error?: Error
  }
}
```

Semantics:

- `q.meta()` is **async** — it returns `Promise<QueryMeta<O>>` that resolves when the stream terminates (drains, cancels, or errors). A user who calls `meta()` while the stream is still producing rows simply waits; no special error for "too early." Live, per-query mid-stream message access is not first-class in v13.0 — see §Info messages.
- `q.meta()` called **before any terminal has fired** throws `TypeError` synchronously. A `Query` that has not been awaited or iterated has no stream to drain, so there is no meta to eventually resolve to — awaiting would hang forever. The synchronous throw surfaces the mistake at the call site. (Contrast with calling mid-stream: there, the stream *is* running, so meta just awaits its completion like any other consumer.)
- On cancellation (`AbortSignal`, iterator `return()`, early rejection), `meta()` still resolves — with whatever tokens arrived before cancel, `completed: false`, and `cancellation` populated. This is useful for debugging ("what info messages did I get before the abort?").
- Inline `await sql\`...\`` users who discard the `Query` reference lose access to meta. That is the expected trade-off for the one-liner ergonomics; holding the reference is one extra line.
- Typing flows from the query source: the procedure builder ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)) parameterises `O` from its `.output()` / `.inout()` declarations, so `(await q.meta()).output.x` is typed without the user having to restate it at the call site.

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
- **envChange** — session-level state changes the driver reports (database, language, collation, packet size, isolation level). The pool does not react to these; consumers who need state consistency when a connection is returned to the pool configure a client-level `onRelease` hook (see [ADR-0011](0011-pool-port.md)), not automatic invalidation.

These three are kept separate because they have different meanings and different consumer needs; mssql v12 collapses the first two into a single `info` event which is a downgrade we do not want to carry forward.

Two paths cover two different consumer shapes in v13.0:

1. **Per-query, post-drain via `q.meta()`** — `info`, `print`, `envChanges` arrays on the trailer object, populated by the time the stream drains. This is the path users reach for when they want to see what messages came back from *this* query. First-class.
2. **Cross-cutting via `diagnostics_channel`** — `mssql:request:info`, `mssql:request:print`, `mssql:request:env-change` publish globally for every request, regardless of listener registration, for APM integration and for structured logging across all queries. The right tool for "log every PRINT my service ever emits" or "feed every info message into the tracing span." See [ADR-0014](0014-diagnostics.md).

```ts
// Per-query: collected from meta() after drain.
const q = sql`exec sp_debug_report`
const [rows, meta] = await Promise.all([q.all(), q.meta()])
meta.print.forEach(msg => log(msg))
```

**Live, per-query mid-stream message access is not first-class in v13.0.** There is no public Query identifier or supported correlation pattern that would let a `diagnostics_channel` subscriber filter to a specific query — using `diagnostics_channel` that way is an anti-pattern. The narrow band where this matters (live PRINT progress on a long migration, interactive debug-proc output) is deferred until real demand emerges and the listener-lifecycle interaction with re-executable templates ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)) is designed. See Alternatives Considered.

**Promote-to-error policy** at the client level, predicate form so the threshold is user-chosen:

```ts
createClient({
  errorOnInfo: (msg) => msg.class >= 11 || msg.number === 2628,   // 2628 = string truncation
})
```

When the predicate returns `true`, core throws a `QueryError` ([ADR-0017](0017-error-taxonomy.md)) at the point in the stream where the info would have been emitted. Rails' `strict_loading` and SQLAlchemy's `filterwarnings('error', SAWarning)` establish this as a familiar pattern; doing it at library level is a genuine win because T-SQL's severity/number system gives us a natural threshold that generic warning-promotion frameworks do not.

## Consequences

- Trailer data (row counts, info, print, envChange, output parameters, return value) is uniformly available via `q.meta()` regardless of which terminal consumed the rows. The inline-await pattern (`await sql\`...\``) discards the `Query` reference and forgoes meta — that is the price of the one-liner, not a hidden cost.
- `.raw()` covers two unrelated needs with one API surface: positional rows for tuple-typed callers, and full preservation of duplicate column names. v12's array-valued duplicate behaviour is dropped in favour of last-wins (matching the pg / mysql2 / ORM ecosystem default), and `.raw()` + `.columns()` is the preservation path for users who need every value ([#1384](https://github.com/tediousjs/node-mssql/issues/1384)).
- `.columns()` resolves before rows are pulled, at the cost of pausing the server-side stream until a consuming terminal (or `.dispose()`) decides. Users who only want the shape pay O(1) network bytes to cancel; users who want both shape and rows pay nothing extra.
- Side-channel data (info / print / envChange) is exposed two ways: per-query, post-drain via `q.meta()` (the default path), and cross-cutting / global via `diagnostics_channel` for APM and structured logging across all queries. v13.0 deliberately does not ship a first-class **live, per-query** path — no public Query identifier, no encouragement to use `diagnostics_channel` for per-query filtering (which would be an anti-pattern). Adding a live-per-query surface later is non-breaking.
- The `errorOnInfo` predicate gives users a SQL-Server-aware promote-to-error policy without a generic warning framework on top — the predicate sees the full `InfoMessage` (class, number, message, procName, lineNumber) and decides per call.

## Alternatives considered

**Per-`Query` `EventEmitter` for live `info` / `print` / `envChange` events.** Considered for the inline ergonomics — `q.on('print', cb)` reads naturally next to `for await (const row of q)`, and Node's `EventEmitter` is the standard observer surface. Deferred to a later v13 minor. The listener-lifecycle story does not survive contact with re-executable templates ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)): `Procedure` and `PreparedStatement` extend `Query<T>` but a "terminal" on them ends a single round-trip, not the object's life — clearing listeners on terminal forces re-registration after every execute, persisting them violates the leak-prevention story raw queries need, and giving the subtypes different listener semantics from the parent makes the inheritance lie. v13.0 ships `q.meta()` as the per-query path (post-drain) and `diagnostics_channel` as the cross-cutting global path; the *live, per-query* band is genuinely narrow and not yet validated by demand. We do not steer users toward `diagnostics_channel` for per-query filtering — that would require a public Query identifier and a correlation pattern we have not designed, and using a global telemetry channel for per-instance observation is the wrong tool for the job. The chained `.onInfo(cb)` / `.onPrint(cb)` shape is deferred for the same reason — it is an alternative spelling of the same surface.

**Put trailer data in each terminal's return shape (no universal `.meta()`).** An earlier draft had `.run()` return `{ rowsAffected, info, print, envChanges }` with `.all()` / `.iterate()` having no meta access at all. Rejected — trailer data is delivered alongside every response (the server sends row counts, info / print / envchange messages, and procedure output parameters as part of completing the request), so gating it behind specific terminals is hiding information the server already paid to send. `q.meta()` as a universal accessor means every consumption path can reach `rowsAffected` without switching terminals. The specific terminals that *do* include meta in their return shape (`.run()`) are retained as convenience shortcuts, not as the sole access path.

**Preserve v12's array-valued duplicate columns (`{ id: [1, 2] }`).** Rejected. It preserves data but disagrees with every other driver in the ecosystem, which is exactly the incompatibility [#1384](https://github.com/tediousjs/node-mssql/issues/1384) raises. The TypeScript typing for `T` already assumes one property per name, so keeping arrays forces a permanent split between what the types say and what runtime delivers. `.raw()` + `.columns()` is the preservation path for users who need it — ships in v13.0 alongside the default.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parent decision; terminal set this ADR builds on.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — `.dispose()` semantics on a `.columns()`-paused stream.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — typed `O` flows from procedure output declarations into `q.meta().output`.
- [ADR-0011: Pool port](0011-pool-port.md) — `onRelease` hook for envChange-driven state reset.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — cross-cutting `mssql:request:info` / `:print` / `:env-change` channels.
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md) — `QueryError` thrown by `errorOnInfo`.
- [tediousjs/node-mssql#1384](https://github.com/tediousjs/node-mssql/issues/1384) — duplicate column names; v13 switches to last-wins, `.raw()` is the escape hatch.
