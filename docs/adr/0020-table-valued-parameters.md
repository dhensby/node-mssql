# ADR-0020: Table-valued parameters (TVPs)

- **Status:** Draft
- **Date:** 2026-05-03
- **Deciders:** @dhensby

## Context

T-SQL Table-Valued Parameters allow passing a set of rows to a stored procedure as a single parameter. They require a corresponding T-SQL `TYPE AS TABLE` declared at the database level; the procedure parameter is typed against that table type. On the wire, TVPs use the TDS TVP token; inside the procedure, they are read-only result sets.

[ADR-0001](0001-scope-and-goals.md) explicitly defers TVPs to post-v13.0; [ADR-0010](0010-driver-port.md) references them via a `TvpCapable` mixin in the capability-interface alternative. v12 supports TVPs via `sql.TVP` and an imperative `Table` builder.

v13 needs a TVP API that:

- Sits on top of the v13 type system ([ADR-0019](0019-sql-type-system.md)) — TVPs are a kind of `SqlType`, not a separate parameter surface.
- Integrates with the procedure builder ([ADR-0009](0009-stored-procedures-and-prepared-statements.md)) using the existing `.input()` form.
- Provides type-level inference of the row shape so the call site is typed without restating column types.
- Translates through the driver port ([ADR-0010](0010-driver-port.md)) — both tedious and msnodesqlv8 support TVPs natively.

## Decision

### Type declaration

A TVP type is declared via `sql.tableType()`:

```ts
const usersType = sql.tableType('app.UsersType', {
  id: sql.Int,
  name: sql.NVarChar(50),
  active: sql.Bit,
})
```

- First argument: the T-SQL type name as it exists in the database (schema-qualified if needed). The library does not auto-create the type; this is a wire-binding name.
- Second argument: a column-name → `SqlType` map matching the T-SQL `TYPE AS TABLE` definition.
- Result: a `SqlType<Row[]>` where `Row` is type-inferred from the column map (`{ id: number; name: string; active: boolean }`).

The `SqlType<Row[]>` brand composes with the type system from ADR-0019 — TVPs are not a separate parameter API surface, just a parameterised type.

### Binding to procedures

A TVP parameter binds via the standard `.input()` form:

```ts
await sql.procedure('sp_bulk_users')
  .input('users', usersType, [
    { id: 1, name: 'Alice', active: true },
    { id: 2, name: 'Bob',   active: false },
  ])
```

The TypeScript signature of `.input()` derives the value type from the `SqlType<T>` brand, so the row array is typed end-to-end without restating column types at the call site.

### Row source

The row source is `Iterable<Row>` or `AsyncIterable<Row>`. Arrays satisfy `Iterable`. For larger TVPs sourced from a generator or another database query, async iterables work directly:

```ts
async function* generateRows() {
  for (let i = 0; i < 10_000; i++) yield { id: i, name: `user-${i}`, active: true }
}

await sql.procedure('sp_bulk_users')
  .input('users', usersType, generateRows())
```

**Open question:** TDS encodes a TVP into the request stream up-front without a length prefix, but rows are sent in sequence. Whether streaming an `AsyncIterable` is materially more memory-efficient than buffering depends on the driver's encode pipeline; needs validation against tedious / msnodesqlv8 implementations before the iterable form's value is settled.

### Out-of-scope: TVPs outside procedures

T-SQL TVPs only attach to stored-procedure parameters. The library does not accept TVPs in tagged-template `` sql`...` `` or `sql.unsafe()` — those surfaces have no typed parameter declaration with direction information, and the T-SQL semantics do not support ad-hoc TVPs anyway. Users wanting table-shaped data through raw SQL fall back to `OPENJSON` / `STRING_SPLIT` patterns inside `sql.unsafe()`.

Whether `sql.prepare()` accepts TVPs is the same question — a prepared statement is just a parameterised reusable plan, and T-SQL allows TVPs as parameters of prepared statements via `sp_executesql` with table types. Tentative answer: yes, prepared statements accept TVPs via the same `.input(name, tableType, rows)` form. Validation needed.

### Driver-port encoding

Drivers MUST encode TVPs to their wire format:

- `tedious` translates the column map and row source to its native `TYPES.TVP` binding using `tedious.Table`.
- `msnodesqlv8` translates to ODBC TVP binding (`SQL_SS_TYPE_TABLE`).

The driver translates at the encoding boundary; the kernel passes the `SqlType<Row[]>` and row source through unchanged. If a row violates a column's `SqlType` (length overflow, type mismatch, missing required column), the driver throws `QueryError` at encode time — never silent truncation.

### Capability interface deferral

v13.0 ships TVP support as a hard requirement of the driver port — both first-party drivers honour it. If a future driver arrives that genuinely cannot support TVPs, `TvpCapable` (per [ADR-0010](0010-driver-port.md)) becomes the additive extension point.

## Consequences

- TVPs are a first-class parameterised `SqlType`, not a separate API surface.
- The procedure builder's `.input()` form handles TVPs without new method signatures.
- Row-type inference flows from the column map to the call site without restating types.
- `Iterable` / `AsyncIterable` row sources allow streaming-friendly construction.
- Driver-port responsibility is clear: encode the TVP, throw on mismatch, no silent data loss.

## Alternatives considered

**Separate `sql.tvp()` API surface distinct from the type system.** Rejected — duplicates the parameter-declaration shape (`.input` vs `.tvpInput` etc.) and loses type-system integration. Treating TVPs as parameterised `SqlType` keeps one surface.

**Imperative `Table` builder (v12 pattern: `.columns.add(...)`, `.rows.add(...)`).** Rejected — fights the type system. Declarative column maps with type-inferred row shapes are how every modern parameterised-data API in TypeScript expresses this; the imperative form gives up the typing for no benefit.

**Allow TVPs in tagged-template / `sql.unsafe()`.** Rejected — T-SQL doesn't support ad-hoc TVPs (the table type must be declared at database level), and the tagged-template / unsafe parameter surfaces have no direction-aware declaration. Users wanting table-shaped data through raw SQL use `OPENJSON` patterns.

**Auto-create the T-SQL `TYPE AS TABLE` from the JS declaration.** Rejected — privilege requirements (DDL access), idempotency, and migration interaction make this a cross-cutting concern that doesn't belong in a connection library. Users declare the type at the schema level using their normal migration tooling and reference it by name.

## Open questions

- `AsyncIterable` row source value vs always materialising — needs validation against driver encode pipelines.
- `sql.prepare()` integration — does prepared-statement binding accept TVPs uniformly, or are there protocol-level constraints?
- Type name validation — should the library validate the T-SQL type name format (schema-qualification rules, identifier escaping), or pass through and let the server reject?
- Row validation timing — pre-encode (eager check, errors at bind) vs during-encode (errors mid-send, request fails partway). Probably pre-encode for predictability.
- Empty TVP handling — `[]` vs `null`; both are valid in T-SQL but mean different things. Default behaviour should match T-SQL's distinction.
- Output TVPs — T-SQL doesn't allow `OUTPUT` direction on TVP parameters, but this should be explicit in the typing so attempting `.output('users', usersType)` is a compile error.

## References

- [ADR-0001: Scope and goals](0001-scope-and-goals.md) — TVPs explicitly deferred to post-v13.0.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — procedure-builder `.input()` shape.
- [ADR-0010: Driver port](0010-driver-port.md) — `TvpCapable` mixin discussion in capability-interface alternative.
- [ADR-0019: SQL type system and type tags](0019-sql-type-system.md) — `SqlType<T>` foundation.
- v12 TVP API: <https://github.com/tediousjs/node-mssql#table-valued-parameter-tvp>.
- T-SQL TVPs: <https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-table-valued-parameters-database-engine>.
