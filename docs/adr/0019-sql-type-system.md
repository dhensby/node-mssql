# ADR-0019: SQL type system and type tags

- **Status:** Draft
- **Date:** 2026-05-03
- **Deciders:** @dhensby

## Context

The SQL type system is a foundational part of v13. The `SqlType` model and its tag set (`types.Int`, `types.VarChar(N)`, `types.Decimal(P, S)`, …) are the shared vocabulary for how a JS value maps to a SQL Server type on the wire, and several other parts of the library build directly on it:

- The procedure / prepared-statement builders' typed `.input()` / `.inout()` / `.output()` declarations ([ADR-0006](0006-queryable-api.md), [ADR-0009](0009-stored-procedures-and-prepared-statements.md)).
- The diagnostics channel `params` shape (`{ type: SqlType, value: unknown }`, [ADR-0014](0014-diagnostics.md)).
- The driver port's `ExecuteRequest` / `BulkOptions` parameter-encoding contract ([ADR-0010](0010-driver-port.md)).

Because so much of the library depends on it, the type system needs a single canonical definition. v12 inherits a comprehensive type-tag set from tedious; v13 defines its own driver-agnostic equivalent so that:

- The tag set and shape are uniform regardless of which driver is loaded.
- Tagged-template parameters get predictable inference defaults.
- Procedure / prepared-statement builders have a stable typed declaration surface.
- The driver port's encoding contract is unambiguous.
- Future feature work (TVPs, bulk load) can build on a settled type model.

## Decision

### Type-tag shape

`SqlType<T>` is a branded value carrying the kind and any parameterisation. The tags live on a `types` namespace exported from the library — `import { types } from 'mssql'` (or `@tediousjs/mssql-core`) — deliberately separate from the `sql` queryable tag. Every tag is called to produce a `SqlType` — one uniform rule, with no bare form. Non-parameterised tags are called with no arguments (`types.Int()`); parameterised tags are called with their parameters (`types.VarChar(255)`, `types.Decimal(18, 2)`), with no defaulted form. The type system enforces both — an un-called tag is a constructor function, not a `SqlType`. To leave a type unspecified, omit the tag and let inference handle the value:

```ts
interface SqlType<T = unknown> {
  readonly kind: SqlKind                      // 'int' | 'varChar' | 'decimal' | 'nvarChar' | ...
  readonly length?: number | 'max'            // VarChar / NVarChar / VarBinary
  readonly precision?: number                 // Decimal / Numeric / DateTime2 / Time / DateTimeOffset
  readonly scale?: number                     // Decimal / Numeric
  readonly userType?: string                  // user-defined type aliases
  readonly _brand: T                          // type-level only; drives JS-value typing
}

// Non-parameterised — called with no arguments:
types.Int()                        // SqlType<number>
types.BigInt()                     // SqlType<bigint>
types.Bit()                        // SqlType<boolean>
types.UniqueIdentifier()           // SqlType<string>
types.DateTime()                   // SqlType<Date>
// ... etc.

// Parameterised — arguments required (type-enforced):
types.VarChar(255)                 // SqlType<string>
types.NVarChar('max')              // SqlType<string>
types.Decimal(18, 2)               // SqlType<number>
types.DateTime2(7)                 // SqlType<Date>
types.VarBinary('max')             // SqlType<Uint8Array>
```

The `_brand` field exists at the type level only (no runtime presence) and parameterises the JS value type — `types.Int()` brands as `SqlType<number>`, `types.NVarChar('max')` as `SqlType<string>` — so the procedure builder's `.input(name, type, value)` and the parameter-binding paths get value-type inference for free.

### Tags are always called

A tag is never a `SqlType` by itself — calling it is what produces the `SqlType`, uniformly across the namespace: `types.Int()`, `types.VarChar(255)`. One rule, nothing to memorise about which tags take parentheses, and the type system enforces it (an un-called tag is a constructor function, not a `SqlType`).

Parameterised tags must be given their parameters in that call — there is no defaulted form. That removes the silent-truncation class of bug by construction: there is no `VARCHAR(8000)` / `NVARCHAR(4000)` default that a longer value quietly overflows, and no `DECIMAL(18, 0)` default that quietly drops fractions — and `Decimal` is not a special case, because the no-defaults rule applies to every parameterised tag. If a caller has gone to the trouble of naming the type, naming its precision is no extra burden; to skip specifying a type at all, omit the tag and let value inference apply (`string → NVarChar('max')`, etc.).

### JS-value-to-SqlType inference for tagged templates

For tagged-template parameters (`` sql`select * from t where x = ${value}` ``), the kernel infers `SqlType` from the JS value's runtime shape:

| JS value | Inferred `SqlType` |
|---|---|
| `number` integer in Int32 range | `Int` |
| `number` integer outside Int32 range | `BigInt` |
| `number` non-integer | `Float` |
| `bigint` | `BigInt` |
| `string` | `NVarChar('max')` |
| `boolean` | `Bit` |
| `Date` | `DateTime2(7)` |
| `Buffer` / `Uint8Array` | `VarBinary('max')` |
| `null` / `undefined` | `NVarChar('max')` `NULL` (see *NULL and typed NULL* below) |

The choices follow conservative defaults that round-trip the JS value losslessly. Where the caller knows the exact type, they wrap the value with the `types.typed(type, value)` helper:

```ts
sql`insert into t (id, label, ratio) values (${id}, ${types.typed(types.VarChar(3), 'ABC')}, ${types.typed(types.Decimal(5, 2), 0.5)})`
```

`types.typed(type, value)` is a value wrapper, not a separate parameter API: a wrapped value is accepted anywhere a bare value is — in a tagged template, in `sql.unsafe(text, params)`'s parameter bag, or in a builder's `.input()` — and the explicit type travels with it instead of being inferred.

### NULL and typed NULL

`null` and `undefined` have no inherent SQL type, but every parameter sent over the wire must be typed. A bare `null` infers to `NVarChar('max')` — the parameter is declared `nvarchar(max)` and sent as `NULL`. This is the established ecosystem default (v12 infers `NVarChar` for null/undefined; .NET's SqlClient does the same for untyped null parameters), and it behaves well almost everywhere: `nvarchar` sits high in SQL Server's implicit-conversion reach, so an `nvarchar` NULL compares against int / decimal / datetime columns and inserts into them without error, always with standard SQL NULL semantics (`x = NULL` is UNKNOWN — no rows; a NULL `LIKE` pattern matches nothing; even `varbinary_col = @p` returns no rows rather than erroring). Where `nvarchar` genuinely cannot go, the failure is loud and server-side: assigning an `nvarchar` NULL to a `varbinary` column raises the implicit-conversion error (257), and a numeric aggregate over a string operand raises the operand-type error (8117). All of these behaviours are live-verified against tedious and SQL Server (Azure SQL Edge).

`sql_variant` was considered as the bare-null target and rejected on driver evidence: tedious supports `sql_variant` for *decoding* result-set columns but has no *parameter encoding* for it (its data-type support matrix lists variant as result-set-only, and every parameter-encoding hook in its variant type throws — live-verified: `addParameter` with `TYPES.Variant` fails client-side validation for null and non-null values alike), so a `Variant` inference would turn every untyped `null` into an immediate client-side error on the primary driver. `Variant` therefore exists in the kind set as a **decode-only** kind for `sql_variant` columns; it is not a parameter type.

When a NULL should carry a concrete declared type — a context like `varbinary` where `nvarchar` cannot convert, or a stable declared type for a nullable non-string parameter (a bare nullable int declares `int` or `nvarchar(max)` depending on the runtime value; string parameters keep one declaration either way) — the caller gives it one through the same wrapper as any other explicit type: `types.typed(types.VarBinary(50), value)` sends `@p varbinary(50) = NULL`, `types.typed(types.Int(), value)` sends `@p int = NULL`. There is no separate typed-NULL API; a typed NULL is simply `types.typed` with a nullable value.

### Driver port encoding contract

Drivers MUST support the full v13 `SqlType` set ([ADR-0010](0010-driver-port.md) "Port surface is sized to the real drivers"). At encode time, the driver translates each `SqlType` + value into its wire format:

- `tedious` maps `SqlKind` to its `TYPES.*` constants and applies length / precision / scale.
- `msnodesqlv8` maps `SqlKind` to ODBC SQL type bindings (`SQL_INTEGER`, `SQL_VARCHAR`, etc.).

Decoded rows return JS values matching the tag's `_brand`. On encode, the driver honours the declared type — rounding scale to fit, as SQL Server does on assignment — rather than imposing a stricter library-level gate; a value whose integer part genuinely overflows the declared precision surfaces the server's arithmetic-overflow error. The library never pre-emptively rejects a value for precision, which would make it unusable for high-precision data.

### Datetime precision

SQL Server's `datetime2`, `datetimeoffset`, and `time` carry up to 100-nanosecond precision (7 fractional-second digits); a JS `Date` resolves only to milliseconds. To avoid silent loss, the decoded `Date` preserves the sub-millisecond remainder rather than discarding it (the approach tedious already takes via a `nanosecondsDelta` property).

`Date` is the v13.0 default — it is what the ecosystem expects. Callers who need full nanosecond precision as a first-class value supply a custom decoder for these columns (via the type-mapping mechanism below) to produce a richer type — `Temporal` (native on Node 26+, or `@js-temporal/polyfill` on older runtimes), Luxon, or a bespoke shape. Core ships no datetime dependency, so the polyfill and its weight are the consumer's opt-in, never bundled. Rolling a bespoke high-precision datetime type into core is explicitly avoided — it would reimplement `Temporal` (calendars, arithmetic, formatting, time zones) at lower quality.

First-class, built-in `Temporal` support — as a default or a one-line option, without a polyfill — is deferred to a future major (v14), once the Node floor ([ADR-0003](0003-runtime-targets.md)) reaches a Temporal-native version.

### Numeric precision

The adapter takes each numeric value from the underlying driver in its lossless form (short-circuiting the driver's own typing) and owns the JS conversion, keyed by `SqlKind`:

- `Int` / `SmallInt` / `TinyInt` → `number` (always exact).
- `Float` / `Real` → `number`.
- `BigInt` → `bigint` (exact; serialising a `bigint` — e.g. to JSON — is the consumer's responsibility).
- `Decimal` / `Numeric` / `Money` → `number` by default. JS has no native exact decimal, so a value beyond a double's ~15–17 significant digits loses precision — a documented runtime limitation, not an error.

Conversion is **per type, not per value**, so a column's JS type is predictable — a `decimal` column is always `number`, never sometimes-`string`. Consumers who need full decimal fidelity register a custom decode (see the Custom type mapping section) to keep the value as a `string` or a `Big`-style type instead of the default `number` parse. Surfacing values losslessly to the adapter is a driver-port responsibility ([ADR-0010](0010-driver-port.md)).

### Custom type mapping

Consumers override how values cross the JS ↔ wire boundary **per client** — not through process-wide mutable state (contrast v12's global `sql.valueHandler` and pg's global `setTypeParser`). The mapping is supplied to `createClient` and applied by the kernel, so it stays driver-agnostic (the binding is per-client, but the handler object is typically defined once at application scope and shared across clients):

```ts
const client = createClient({
  typeHandlers: {                              // name TBD
    // decode (wire → JS): keyed by SqlKind; reconstructs a richer type from
    // the driver's canonical decoded value.
    decode: {
      datetime2: dt => toTemporal(dt),
      decimal: s => new Big(s),                // needs the driver to decode decimal losslessly (a string)
    },
    // encode (JS → SqlType): an ordered, first-match-wins rule stack. Each
    // rule returns { type, value } to claim a value (value may be transformed),
    // or undefined to pass it on.
    encode: [
      v => v instanceof Money ? { type: types.Decimal(19, 4), value: v.toString() } : undefined,
    ],
  },
})
```

**Why per-client and not global:** a process-wide mapping is mutable state shared by every consumer in the process. Any module — including a transitive dependency that happens to use this library — can rewire decoding for everyone else's queries; registration must win the import-order race to run before the first query; two clients with different needs (a reporting client decoding `decimal` to a `Big`, an app client happy with `number`) cannot be expressed; and parallel tests cannot isolate their mappings. pg's global `setTypeParser` is the cautionary tale, and pg itself later grew a per-client escape (`new Pool({ types })`) because the global hurt. The per-client cost is one argument — define the handler object once at application scope and pass it to each `createClient` — which keeps v12's set-once-for-the-app ergonomics without the process-global hazard.

**Encode resolution order:** an explicit `types.typed(type, value)` always wins; otherwise the `encode` stack runs first-match-wins; otherwise the built-in inference table applies. A custom JS type therefore round-trips by registering both halves — an `encode` rule that serialises it to a `SqlType` + wire-encodable value, and a `decode` override (keyed by the resulting `SqlKind`) that reconstructs it.

**Decode is per-`SqlKind`, not per-column.** Result columns are not user-typed, so a decode override applies to every value of that kind in the result — the same granularity as v12's `valueHandler` and pg's `setTypeParser`. Per-column shaping is the caller's own post-processing or a SQL-side `CAST`.

### Spatial types and custom UDTs

`geometry` and `geography` are first-class in v13.0 via portable `types.Geometry` / `types.Geography` tags, decoded by a **dependency-free** parser in core — the driver surfaces the raw spatial binary and core parses it into structured objects (points / figures / shapes for `geometry`; `lat` / `lng` for `geography`), as v12 does today (its bespoke `lib/udt.js`). Parsing is driver-agnostic — the on-wire format is the server's, not the driver's — so it is uniform across tedious and msnodesqlv8, and introduces no extra package or dependency.

T-SQL `CREATE TYPE FROM` aliases over base types are addressable via the corresponding base-type tag — `types.VarChar(50)` works for a `MyEmail VARCHAR(50)` UDT.

True CLR UDTs that core does not model are reached via the driver-native escape hatch (raw binary / driver-specific binding). `hierarchyid` stays on that escape hatch unless concrete demand justifies a first-class tag.

### Cross-driver consistency

The tag set is identical regardless of loaded driver. Drivers translate at the encoding boundary; the kernel and user-facing API are driver-agnostic.

If genuine asymmetry emerges (a future driver that can't honour a tag), capability interfaces (`Preparable` / `BulkCapable` / etc., per [ADR-0010](0010-driver-port.md)) would extend to type capabilities — but no such asymmetry exists in v13.0.

## Consequences

- The library has one canonical type-tag set; users learn it once.
- Tagged-template parameters work without any explicit typing in the common case.
- Procedure / prepared-statement builders get value-type inference from the tag at the type level.
- The driver port's encoding contract is unambiguous: every `SqlType` is a driver responsibility.
- Spatial types (`geometry` / `geography`) are first-class in v13.0 via a dependency-free core parser; only true CLR UDTs and `hierarchyid` remain on the driver-native escape hatch, with first-class tags for them an additive future addition.
- The NULL parameter behaviour is a documentation commitment: the user-facing docs must explicitly cover the bare-null default (`nvarchar(max)` `NULL`), its edge cases, and the `types.typed(type, value)` typed-NULL escape.

## Alternatives considered

**Re-export tedious's `TYPES` directly.** Rejected — couples the library's user-facing surface to a specific driver's internal type taxonomy. Defining `SqlType` in core decouples the type system from any driver and gives msnodesqlv8 (and future drivers) a uniform target to translate against.

**TypeScript-only type system (no runtime tags, just type-level brands).** Rejected — runtime tags are needed for procedure / prepared-statement builders (`.input(name, type, value)` needs a runtime `type`) and for the driver-port encoding contract (the driver needs to know what to send on the wire). Type-level only would push that information back into JS-value inspection, which is fragile.

**Each driver exports its own tag set, library re-exports a union.** Rejected — defeats portability. Users would have to know which driver they're using to write parameter declarations.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — procedure-builder typed input declarations.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — `.input()` / `.inout()` / `.output()` shape.
- [ADR-0010: Driver port](0010-driver-port.md) — encoding contract.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — `params` channel-context shape.
- v12 type-tag set: <https://github.com/tediousjs/node-mssql#data-types>.
- tedious data types: <https://tediousjs.github.io/tedious/api-datatypes.html>.
