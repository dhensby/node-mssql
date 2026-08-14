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
- Diagnostics — start / end with a `rowsLoaded` count — plus first-class progress reporting for long-running loads (an application concern, mirrored to diagnostics for observability).

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
  batchSize?: number              // rows per batch, kernel-implemented — one INSERT BULK statement
                                  // per batch (default: no batching — one atomic statement)
  keepNulls?: boolean             // KEEP_NULLS — preserve NULLs vs apply column defaults
  keepIdentity?: boolean          // KEEP_IDENTITY — load explicit identity values
  tableLock?: boolean             // TABLOCK — bulk-update lock for duration of load
  checkConstraints?: boolean      // CHECK_CONSTRAINTS — apply constraints (default off for bulk)
  fireTriggers?: boolean          // FIRE_TRIGGERS — fire INSERT triggers (default off for bulk)
  onProgress?: (progress: BulkProgress) => void  // per confirmed batch — see Progress below
  native?: unknown                // driver-specific escape hatch
}
```

Names match the T-SQL / SqlBulkCopy convention (camelCase'd): a user familiar with the SQL Server bulk-load surface recognises them. Defaults match SQL Server's bulk-load defaults (constraints / triggers off, no batching).

### `BulkResult`

```ts
interface BulkResult {
  rowsLoaded: number              // rows the server confirmed loaded (sum of batch DONE counts)
}
```

A resolved `BulkResult` always means the whole load completed — partial outcomes are never a resolution. Any failure rejects with `BulkError`, which carries the loaded-vs-sent context (see Failure handling).

### Failure handling

Bulk load mimics the server's own semantics: **fail fast, statement-atomic**. Neither TDS bulk load nor the drivers offer per-row error reporting or continue-past-error — a TDS ERROR token carries no row ordinal, tedious surfaces exactly one terminal error per load, and one bulk load is one `INSERT BULK` statement that SQL Server aborts and rolls back wholesale on the first error (live-verified: a mid-stream PK violation rolled back the valid rows sent before it; the driver reported `rowCount` 0, never a partial count). This is the ecosystem norm — SqlBulkCopy and JDBC bulk copy are equally fail-fast with no skip-bad-rows mode, and bcp's `MAXERRORS` tolerance is client-side only (rows the *client* fails to convert; server-rejected rows always abort).

Consequences for the API:

- **Success is total.** A resolved `BulkResult` means every row loaded; there is no partial-success resolution.
- **Failure throws `BulkError`** ([ADR-0017](0017-error-taxonomy.md) family) carrying `rowsLoaded` (server-confirmed rows from committed batches), `rowsSent` (rows pulled from the source and put on the wire), `batchIndex` (the failing batch, when batching), and the server error as `cause`. Failing-batch granularity is the honest maximum: the protocol cannot identify the failing *row* — the server error sometimes names the offending value or column ordinal, never the row position, and the ADR commits to documenting that.
- **At most one error per load.** The server halts at the first failure, so there is no error set to accumulate or stream — no memory concern, and no per-request event surface needed.
- **Batching bounds the blast radius.** With `batchSize`, one `INSERT BULK` statement runs per batch: committed batches persist (the committed prefix — the same semantics as SqlBulkCopy's `BatchSize` and bcp's `-b`), the failing batch rolls back, the load halts. Unlike SqlBulkCopy — which does not report how much was committed — `BulkError.rowsLoaded` states it.
- **All-or-nothing is composition, not a flag.** `await using tx = await sql.transaction(); await tx.bulkLoad(...).load(rows)` makes the whole load one transaction regardless of batching. No `rollbackOnError` option — SqlBulkCopy's equivalent (`UseInternalTransaction`) is incompatible with an external transaction, a wart composition avoids.
- `AbortSignal` ([ADR-0013](0013-cancellation-and-timeouts.md)) cancels the load mid-stream; committed batches persist per the same rules.

### Progress — first-class, not diagnostics

Long-running loads need progress in the application itself, and diagnostics channels are observability — never the app's data path. Progress is therefore first-class: `BulkOptions.onProgress` is invoked once per server-confirmed batch with cumulative counts (precedent: SqlBulkCopy's `NotifyAfter` + `SqlRowsCopied`):

```ts
interface BulkProgress {
  rowsLoaded: number              // cumulative server-confirmed rows (committed batches)
  batchIndex: number              // 0-based index of the batch just confirmed
}
```

The callback covers the one signal the caller cannot self-serve: server acknowledgement. Rows *sent* are already observable in the caller's own row source — it is their iterable, countable in a wrapper. Without `batchSize` there are no intermediate acknowledgements, so the callback fires once at completion — meaningful progress cadence is one of the reasons to batch. Cancellation composes via the existing `AbortSignal`, not a return value from the callback (contrast SqlBulkCopy's `SqlRowsCopied.Abort`).

### Connection lifecycle

Bulk load is connection-pinned for its duration — like `PreparedStatement` ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)), the wire is held by the bulk-insert stream until the load completes or aborts. Cancel paths return the connection to the pool clean (driver-cancel + reset on release, per [ADR-0008](0008-query-lifecycle-and-disposal.md) / [ADR-0010](0010-driver-port.md)).

### Diagnostics channels

Bulk load reinstates the `mssql:bulk` tracingChannel previously dropped from ADR-0014:

- **`mssql:bulk` start context:** `{ table, columns, options, database, serverAddress, serverPort?, connectionId, queryId }` — `columns` is the column-name → `SqlKind`-and-parameterisation snapshot (no row data).
- **`mssql:bulk` `asyncEnd` context (success path):** `{ rowsLoaded }` plus the common `reason: 'completed'` / `reason: 'cancelled'` termination block from ADR-0014.
- **`mssql:bulk:progress` point channel:** `{ rowsLoaded, batchIndex, queryId }` — fires once per server-confirmed batch, mirroring `onProgress` for observability consumers (APM spans, operator dashboards). It is not an application data path — application code uses the first-class `onProgress` option.

The progress channel earns its place (vs being dropped as premature) because bulk load is the case where one operation generates millions of rows of work — operators genuinely need progress visibility, and the channel is the right shape.

### Driver port

`Connection.bulkLoad(opts)` ([ADR-0010](0010-driver-port.md)) gets fleshed out:

```ts
interface BulkLoadOptions {
  table: string
  columns: Array<{ name: string, type: SqlType }>
  rows: AsyncIterable<unknown[]>      // positional, in column order
  options: BulkOptions                // wire options; batchSize / onProgress are kernel-implemented
}

interface BulkResult { rowsLoaded: number }

interface Connection {
  bulkLoad(opts: BulkLoadOptions, signal?: AbortSignal): Promise<BulkResult>
}
```

The driver translates to wire format:
- `tedious` uses native `BulkLoad` with column declarations and the row stream.
- `msnodesqlv8` uses ODBC bulk-insert primitives.

Batching lives in the kernel: with `batchSize` set, the kernel chunks the row source and issues one `Connection.bulkLoad()` per batch — the port stays one-statement-per-call, matching the drivers' native shape (tedious has no batching primitive; one `bulkLoad` is one `INSERT BULK` statement). Because the kernel sees each batch resolve, it fires `onProgress` and publishes `mssql:bulk:progress` itself; drivers need no progress hook.

## Consequences

- Bulk load is a first-class queryable-tier feature with a builder shape consistent with `Query` / `Procedure` / `PreparedStatement`.
- Column declaration sits on top of the v13 type system; row shape is type-inferred at the call site.
- `AsyncIterable` row sources allow streaming end-to-end without buffering the full row set.
- Failure semantics mirror the server (live-verified): fail-fast, statement-atomic, committed-prefix under batching. Failures throw `BulkError` with loaded-vs-sent context; a resolution is always a total success.
- Progress is first-class (`onProgress`) — an application feature — with the diagnostics channel as its observability mirror.
- `mssql:bulk` and `mssql:bulk:progress` channels return to the diagnostics surface — designed against an actual user-facing API rather than speculatively.
- The driver port's `bulkLoad()` method gets a settled `BulkLoadOptions` shape that drivers translate.

## Alternatives considered

**Make bulk load a terminal on `Query<T>`.** Rejected — bulk load doesn't fit the `Query<T>` cardinality terminals (`.all()`, `.iterate()`, `.run()`, `.result()`) — it's not a query that returns rows, it's a write operation with its own options surface. A dedicated builder keeps the queryable terminals focused on read / DML semantics.

**Single-call API: `sql.bulkLoad(table, columns, rows, options)`.** Considered. Rejected because the four-argument call site reads worse than the chained builder, and fluent `.columns()` / `.options()` lets users assign the configuration to a variable and reuse it across multiple `.load()` calls (e.g., a long-running ETL job loading multiple sources into the same table).

**Auto-create the target table from the column declaration.** Rejected for the same reason as auto-creating TVP types ([ADR-0020](0020-table-valued-parameters.md)) — DDL access, idempotency, and migration interaction don't belong in a connection library.

**Shared row-source representation across TVP and bulk-load.** Considered (both take `AsyncIterable<Row>` over a typed schema). Kept the surfaces distinct because TVPs bind to a procedure parameter while bulk load targets a table — different verbs at the call site read more clearly than a unified "row-source" abstraction that the user has to disambiguate by context. The underlying `Iterable<Row>` shape is the same, which is the part that matters at the type level.

**Drop `mssql:bulk:progress`; consumers poll `q.meta()` mid-load.** Rejected — `q.meta()` is post-drain only ([ADR-0007](0007-query-result-presentation.md)), so it doesn't serve mid-load progress. First-class `onProgress` for the application, mirrored on the channel for observability, is the right shape.

**Collect row errors and continue loading (report at the end, or emit as they occur).** Rejected — not implementable on the wire. TDS bulk load has no per-row error channel and no continue-past-error: the server aborts the statement at the first failure, so there is at most one terminal error per load and nothing to collect (which also removes any concern about an unbounded error set in memory). The only mainstream server-side tolerance is PostgreSQL 17's `COPY … ON_ERROR ignore`, which covers input-conversion errors only — constraint violations still abort — and TDS has no equivalent. A bounded client-side tolerance à la bcp `MAXERRORS` (skip rows that fail client-side encoding, cap the skips, surface the rejects) is buildable as a future additive option if demand appears, but rows the *server* rejects can never be skipped.

## Open questions

- `bulkLoad()` on `Transaction` / `ReservedConn` — symmetric with how the queryable surfaces flow into scope handles. Almost certainly yes (just exposing the same builder), but the exact integration needs validation.
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
