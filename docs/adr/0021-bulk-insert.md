# ADR-0021: Bulk insert / bulk load

- **Status:** Draft
- **Date:** 2026-05-03
- **Deciders:** @dhensby

## Context

SQL Server's bulk-load path (TDS bulk-insert tokens, equivalent to `BCP` / `SqlBulkCopy` / `BULK INSERT` in T-SQL) moves large row volumes into a target table at materially higher throughput than per-row `INSERT` statements. It bypasses standard parameterised-execution overhead, supports server-side batching, and exposes options (`KEEP_NULLS`, `KEEP_IDENTITY`, `TABLOCK`, `CHECK_CONSTRAINTS`, …) that aren't available through the regular query path.

[ADR-0001](0001-scope-and-goals.md) explicitly defers bulk load to post-v13.0. [ADR-0010](0010-driver-port.md) carries `bulkLoad(opts: BulkOptions): Promise<BulkResult>` on the driver port (a real driver capability that drivers must implement) but no user-facing surface invokes it. The diagnostics ADR ([ADR-0014](0014-diagnostics.md)) previously specified an `mssql:bulk` channel and an `mssql:bulk:progress` channel; both were dropped as premature when the user-facing API hadn't been designed yet.

v13 needs:

- A queryable-tier API for invoking bulk load.
- A column-and-row declaration that integrates with the v13 type system ([ADR-0019](0019-sql-type-system.md)).
- A streaming row source (this is the use case where `AsyncIterable` genuinely earns its place).
- Bulk-specific options exposed without bloating the general queryable surface.
- Diagnostics — at minimum, start / end with a `rowsLoaded` count; progress emission for long-running loads is an open question.

## Decision

### Builder shape

Bulk load uses a dedicated builder accessed via `sql.bulkLoad()`:

```ts
await sql.bulkLoad('app.users')
  .columns({
    id: sql.Int,
    name: sql.NVarChar(50),
    active: sql.Bit,
  })
  .options({ keepNulls: true, batchSize: 1000 })
  .load(rowSource)          // terminal — Promise<BulkResult>
```

- `sql.bulkLoad(table)` — target table name, schema-qualified if needed.
- `.columns(map)` — column name → `SqlType` map. The TypeScript brand on each `SqlType` types the row shape so the row source is checked at the call site.
- `.options(opts)` — bulk-specific options (see below). Optional.
- `.load(rowSource)` — terminal that kicks off the bulk insert. Returns `Promise<BulkResult>`.

The builder is **immutable-fluent** ([ADR-0009](0009-stored-procedures-and-prepared-statements.md) precedent): each call returns a new builder. The intermediate object is not directly awaitable — `.load()` is the explicit terminal so the row-source argument is unambiguous and the call site reads as the deliberate kick-off it represents.

### Row source — streaming-first

`.load(rowSource)` accepts `Iterable<Row>` or `AsyncIterable<Row>`, where `Row` is the type derived from the column map's brands. Arrays satisfy `Iterable`. For the use case bulk load actually targets — moving large volumes — async iterables are how callers source rows from another query, a file stream, an HTTP response, etc.:

```ts
async function* fromCsv() {
  for await (const line of csvLineStream) yield parseRow(line)
}

await sql.bulkLoad('app.users')
  .columns({ id: sql.Int, name: sql.NVarChar(50), active: sql.Bit })
  .load(fromCsv())
```

Unlike TVPs (where the row count is needed up-front for the TDS TVP token, so `AsyncIterable` value is in question), TDS bulk-insert is a streaming wire format — rows go on the wire in batches without a total count requirement. `AsyncIterable` is genuinely streaming end to end here.

### `BulkOptions` surface

```ts
interface BulkOptions {
  batchSize?: number              // rows per server-side batch (default: driver-chosen)
  keepNulls?: boolean             // KEEP_NULLS — preserve NULLs vs apply column defaults
  keepIdentity?: boolean          // KEEP_IDENTITY — load explicit identity values
  tableLock?: boolean             // TABLOCK — bulk-update lock for duration of load
  checkConstraints?: boolean      // CHECK_CONSTRAINTS — apply constraints (default off for bulk)
  fireTriggers?: boolean          // FIRE_TRIGGERS — fire INSERT triggers (default off for bulk)
  native?: unknown                // driver-specific escape hatch
}
```

Names match the T-SQL / SqlBulkCopy convention (camelCase'd): a user familiar with the SQL Server bulk-load surface recognises them. Defaults match SQL Server's bulk-load defaults (constraints / triggers off, batch size driver-chosen).

### `BulkResult`

```ts
interface BulkResult {
  rowsLoaded: number              // rows the server confirmed loaded
  // open: per-batch breakdown? error-row info on partial failure?
}
```

Open question: for partial failures (a batch fails server-side mid-load), whether `BulkResult` should include the partially-loaded count and the failure point, or whether the rejection just throws with a total-rows-attempted-vs-loaded context. Tied to the failure-handling design below.

### Failure handling

T-SQL bulk-load can fail mid-stream — a constraint violation in batch N rolls back that batch (or the whole load, depending on options). Tentative semantics:

- A constraint / type-encoding error during a batch throws `QueryError` with the offending batch / row context attached as soon as the server signals it.
- In-flight batches before the failure stay committed unless the load was wrapped in a transaction — the transaction-scope decision is the consumer's, not the library's.
- `AbortSignal` ([ADR-0013](0013-cancellation-and-timeouts.md)) cancels the load mid-stream; partial commits are visible to the database state per the same rule.

Open question: should `BulkOptions` include a `rollbackOnError` knob that wraps the load in an internal transaction? Probably no — composing with the existing `sql.transaction()` is the clean answer (`await using tx = await sql.transaction(); await tx.bulkLoad(...).load(rows)` — analogous to `tx.acquire()`). Validation needed.

### Connection lifecycle

Bulk load is connection-pinned for its duration — like `PreparedStatement` ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)), the wire is held by the bulk-insert stream until the load completes or aborts. Cancel paths return the connection to the pool clean (driver-cancel + reset on release, per [ADR-0008](0008-query-lifecycle-and-disposal.md) / [ADR-0010](0010-driver-port.md)).

### Diagnostics channels

Bulk load reinstates the `mssql:bulk` tracingChannel previously dropped from ADR-0014:

- **`mssql:bulk` start context:** `{ table, columns, options, database, serverAddress, serverPort?, connectionId, queryId }` — `columns` is the column-name → `SqlKind`-and-parameterisation snapshot (no row data).
- **`mssql:bulk` `asyncEnd` context (success path):** `{ rowsLoaded }` plus the common `reason: 'completed'` / `reason: 'cancelled'` termination block from ADR-0014.
- **`mssql:bulk:progress` point channel:** `{ rowsCommitted, batchIndex, queryId }` — fires once per server-confirmed batch. Enables long-running-load progress UIs without polling.

The progress channel earns its place (vs being dropped as premature) because bulk load is the case where one operation generates millions of rows of work — operators genuinely need progress visibility, and the channel is the right shape.

### Driver port

`Connection.bulkLoad(opts)` ([ADR-0010](0010-driver-port.md)) gets fleshed out:

```ts
interface BulkLoadOptions {
  table: string
  columns: Array<{ name: string, type: SqlType }>
  rows: AsyncIterable<unknown[]>      // positional, in column order
  options: BulkOptions
}

interface BulkResult { rowsLoaded: number }

interface Connection {
  bulkLoad(opts: BulkLoadOptions, signal?: AbortSignal): Promise<BulkResult>
}
```

The driver translates to wire format:
- `tedious` uses native `BulkLoad` with column declarations and the row stream.
- `msnodesqlv8` uses ODBC bulk-insert primitives.

Drivers MUST emit `mssql:bulk:progress` per server-confirmed batch (the kernel cannot synthesise this — only the driver knows when the server acked a batch).

## Consequences

- Bulk load is a first-class queryable-tier feature with a builder shape consistent with `Query` / `Procedure` / `PreparedStatement`.
- Column declaration sits on top of the v13 type system; row shape is type-inferred at the call site.
- `AsyncIterable` row sources allow streaming end-to-end without buffering the full row set.
- `mssql:bulk` and `mssql:bulk:progress` channels return to the diagnostics surface — designed against an actual user-facing API rather than speculatively.
- The driver port's `bulkLoad()` method gets a settled `BulkLoadOptions` shape that drivers translate.

## Alternatives considered

**Make bulk load a terminal on `Query<T>`.** Rejected — bulk load doesn't fit the `Query<T>` cardinality terminals (`.all()`, `.iterate()`, `.run()`, `.result()`) — it's not a query that returns rows, it's a write operation with its own options surface. A dedicated builder keeps the queryable terminals focused on read / DML semantics.

**Single-call API: `sql.bulkLoad(table, columns, rows, options)`.** Considered. Rejected because the four-argument call site reads worse than the chained builder, and fluent `.columns()` / `.options()` lets users assign the configuration to a variable and reuse it across multiple `.load()` calls (e.g., a long-running ETL job loading multiple sources into the same table).

**Auto-create the target table from the column declaration.** Rejected for the same reason as auto-creating TVP types ([ADR-0020](0020-table-valued-parameters.md)) — DDL access, idempotency, and migration interaction don't belong in a connection library.

**Shared row-source representation across TVP and bulk-load.** Considered (both take `AsyncIterable<Row>` over a typed schema). Kept the surfaces distinct because TVPs bind to a procedure parameter while bulk load targets a table — different verbs at the call site read more clearly than a unified "row-source" abstraction that the user has to disambiguate by context. The underlying `Iterable<Row>` shape is the same, which is the part that matters at the type level.

**Drop `mssql:bulk:progress`; consumers poll `q.meta()` mid-load.** Rejected — `q.meta()` is post-drain only ([ADR-0007](0007-query-result-presentation.md)), so it doesn't serve mid-load progress. A dedicated progress channel is the right shape.

## Open questions

- Failure handling — does `BulkOptions` get a `rollbackOnError` flag, or do users compose with `sql.transaction()` for atomic bulk loads? Tentative: compose, no flag.
- `BulkResult` shape on partial failure — does the result include attempted-vs-loaded counts, or does the rejection carry that on the error?
- `bulkLoad()` on `Transaction` / `ReservedConn` — symmetric with how the queryable surfaces flow into scope handles. Almost certainly yes (just exposing the same builder), but the exact integration needs validation.
- `mssql:bulk:progress` cadence — per-batch (server ack) or throttled (every N rows or N seconds)? Per-batch is simpler; throttling is a subscriber concern.
- Identity column handling — `keepIdentity: true` with a column declaration that omits the identity column should presumably error at validation; design that check.
- `BulkOptions.native` shape — what driver-specific knobs does each driver want surfaced? Subject to validation against tedious / msnodesqlv8 docs.

## References

- [ADR-0001: Scope and goals](0001-scope-and-goals.md) — bulk load explicitly deferred to post-v13.0.
- [ADR-0007: Query result presentation](0007-query-result-presentation.md) — `q.meta()` is post-drain, motivating a dedicated progress channel.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — connection-pinning and reset-on-release.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — immutable-fluent builder precedent.
- [ADR-0010: Driver port](0010-driver-port.md) — `bulkLoad()` method + `BulkOptions`.
- [ADR-0013: Cancellation and timeouts](0013-cancellation-and-timeouts.md) — `AbortSignal` cancellation semantics.
- [ADR-0019: SQL type system and type tags](0019-sql-type-system.md) — `SqlType<T>` foundation.
- [ADR-0020: Table-valued parameters](0020-table-valued-parameters.md) — TVP design choices that influenced bulk-load shape.
- T-SQL `BULK INSERT`: <https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql>.
- v12 bulk API: <https://github.com/tediousjs/node-mssql#bulk-load>.
- tedious `BulkLoad`: <https://tediousjs.github.io/tedious/api-bulkload.html>.
