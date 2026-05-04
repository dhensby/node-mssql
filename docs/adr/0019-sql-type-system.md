# ADR-0019: SQL type system and type tags

- **Status:** Draft
- **Date:** 2026-05-03
- **Deciders:** @dhensby

## Context

Several accepted v13 ADRs refer to a SQL type system as if it is settled — `sql.Int`, `sql.VarChar(N)`, `sql.Decimal(P, S)`, and a generic `SqlType` marker — without any ADR formally defining the surface. The type system is referenced by:

- The procedure / prepared-statement builders' typed `.input()` / `.inout()` / `.output()` declarations ([ADR-0006](0006-queryable-api.md), [ADR-0009](0009-stored-procedures-and-prepared-statements.md)).
- The diagnostics channel `params` shape (`{ type: SqlType, value: unknown }`, [ADR-0014](0014-diagnostics.md)).
- The driver port's `ExecuteRequest` / `BulkOptions` parameter encoding contract ([ADR-0010](0010-driver-port.md)).

v12 inherits a comprehensive set of type tags from tedious. v13 needs to formalise the surface so:

- The tag set and shape are uniform regardless of which driver is loaded.
- Tagged-template parameters get predictable inference defaults.
- Procedure / prepared-statement builders have a stable typed declaration surface.
- The driver port's encoding contract is unambiguous.
- Future feature work (TVPs, bulk load) can build on a settled type model.

## Decision

### Type-tag shape

`SqlType<T>` is a branded value carrying the kind and any parameterisation. Tags are exported from core as both direct values (for non-parameterised types) and constructor functions (for parameterised ones):

```ts
interface SqlType<T = unknown> {
  readonly kind: SqlKind                      // 'int' | 'varChar' | 'decimal' | 'nvarChar' | ...
  readonly length?: number | 'max'            // VarChar / NVarChar / VarBinary
  readonly precision?: number                 // Decimal / Numeric / DateTime2 / Time / DateTimeOffset
  readonly scale?: number                     // Decimal / Numeric
  readonly userType?: string                  // user-defined type aliases
  readonly _brand: T                          // type-level only; drives JS-value typing
}

// Direct values (non-parameterised):
sql.Int                            // SqlType<number>
sql.BigInt                         // SqlType<bigint>
sql.Bit                            // SqlType<boolean>
sql.UniqueIdentifier               // SqlType<string>
sql.DateTime                       // SqlType<Date>
// ... etc.

// Constructor functions (parameterised):
sql.VarChar(255)                   // SqlType<string>
sql.NVarChar('max')                // SqlType<string>
sql.Decimal(18, 2)                 // SqlType<number>
sql.DateTime2(7)                   // SqlType<Date>
sql.VarBinary('max')               // SqlType<Uint8Array>
```

The `_brand` field exists at the type level only (no runtime presence) and parameterises the JS value type — `sql.Int` brands as `SqlType<number>`, `sql.NVarChar('max')` as `SqlType<string>` — so the procedure builder's `.input(name, type, value)` and the parameter-binding paths get value-type inference for free.

### Parameterised type defaults

When a parameterised tag is referenced bare (e.g. `sql.VarChar` without parens), the driver's natural default applies — `VARCHAR(8000)`, `NVARCHAR(4000)`, `VARBINARY(8000)`, `DECIMAL(18, 0)`, `DATETIME2(7)` — matching SQL Server's defaults for the corresponding T-SQL types. Bare references are a convenience; explicit parameterisation is recommended where the column / parameter spec is known.

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
| `null` / `undefined` | `Variant` (driver-translated to typed `NULL` per context) |

The choices follow conservative defaults that round-trip the JS value losslessly. Users wanting different types reach for **explicit type tagging** via the `sql.typed(value, type)` form:

```ts
sql`insert into t (id, label, ratio) values (${id}, ${sql.typed('ABC', sql.VarChar(3))}, ${sql.typed(0.5, sql.Decimal(5, 2))})`
```

`sql.typed(value, type)` is a value-wrapping helper — not a separate parameter API surface — so it composes with the standard tag form.

### Driver port encoding contract

Drivers MUST support the full v13 `SqlType` set ([ADR-0010](0010-driver-port.md) "Port surface is sized to the real drivers"). At encode time, the driver translates each `SqlType` + value into its wire format:

- `tedious` maps `SqlKind` to its `TYPES.*` constants and applies length / precision / scale.
- `msnodesqlv8` maps `SqlKind` to ODBC SQL type bindings (`SQL_INTEGER`, `SQL_VARCHAR`, etc.).

Decoded rows return JS values matching the tag's `_brand`. If a driver genuinely cannot encode a value (e.g. a `Decimal` value that exceeds the declared precision), it throws `QueryError` or `DriverError` at encode time — never silent truncation.

### Custom UDTs and the driver-native escape hatch

T-SQL `CREATE TYPE FROM` aliases over base types are addressable today via the corresponding base-type tag — `sql.VarChar(50)` works for a `MyEmail VARCHAR(50)` UDT.

True user-defined types (CLR UDTs, spatial types, `hierarchyid`) need driver-specific encoding that core does not formalise in v13.0. Users reach for the driver-native escape hatch (driver-specific binding in the parameter value) until concrete demand justifies first-class tags.

**Open question:** spatial types (`geometry`, `geography`) and `hierarchyid` have first-class tedious support; whether to lift them to portable tags in v13.0 or defer to a follow-up depends on driver-symmetry analysis.

### Cross-driver consistency

The tag set is identical regardless of loaded driver. Drivers translate at the encoding boundary; the kernel and user-facing API are driver-agnostic.

If genuine asymmetry emerges (a future driver that can't honour a tag), capability interfaces (`Preparable` / `BulkCapable` / etc., per [ADR-0010](0010-driver-port.md)) would extend to type capabilities — but no such asymmetry exists in v13.0.

## Consequences

- The library has one canonical type-tag set; users learn it once.
- Tagged-template parameters work without any explicit typing in the common case.
- Procedure / prepared-statement builders get value-type inference from the tag at the type level.
- The driver port's encoding contract is unambiguous: every `SqlType` is a driver responsibility.
- Custom UDTs and spatial types stay on the driver-native escape hatch in v13.0; first-class tags are an additive future addition.

## Alternatives considered

**Re-export tedious's `TYPES` directly.** Rejected — couples the library's user-facing surface to a specific driver's internal type taxonomy. Defining `SqlType` in core decouples the type system from any driver and gives msnodesqlv8 (and future drivers) a uniform target to translate against.

**TypeScript-only type system (no runtime tags, just type-level brands).** Rejected — runtime tags are needed for procedure / prepared-statement builders (`.input(name, type, value)` needs a runtime `type`) and for the driver-port encoding contract (the driver needs to know what to send on the wire). Type-level only would push that information back into JS-value inspection, which is fragile.

**Each driver exports its own tag set, library re-exports a union.** Rejected — defeats portability. Users would have to know which driver they're using to write parameter declarations.

## Open questions

- Spatial type / `hierarchyid` lifting to portable tags vs deferral to driver-native.
- Whether non-parameterised tags should also be callable (`sql.Int()`) for consistency, or remain bare references (the choice in the sketch).
- The exact `sql.typed(value, type)` shape — composition with templates needs validation.
- Default length for bare `sql.VarChar` etc. — driver default vs library opinion.
- How `Variant` (the JS `null` / `undefined` inference target) interacts with strictly-typed columns; may need a refinement for typed `NULL`.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — procedure-builder typed input declarations.
- [ADR-0009: Stored procedures and prepared statements](0009-stored-procedures-and-prepared-statements.md) — `.input()` / `.inout()` / `.output()` shape.
- [ADR-0010: Driver port](0010-driver-port.md) — encoding contract.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — `params` channel-context shape.
- v12 type-tag set: <https://github.com/tediousjs/node-mssql#data-types>.
- tedious data types: <https://tediousjs.github.io/tedious/api-datatypes.html>.
