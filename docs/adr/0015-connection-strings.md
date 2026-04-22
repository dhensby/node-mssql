# ADR-0015: Connection string parsing — core-owned, driver schemas composed

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

SQL Server connection strings exist in multiple dialects — ODBC, ADO.NET, JDBC, and v12-node-mssql's own — and users copy-paste from Azure portal, other codebases, or Stack Overflow without tracking which dialect they got. v12 has two parsers (one for tedious, one for msnodesqlv8) that accept overlapping but non-identical subsets of keys. This is the source of issues [#1230](https://github.com/tediousjs/node-mssql/issues/1230) and [#1400](https://github.com/tediousjs/node-mssql/issues/1400): options set in the string silently fail to propagate through one of the two paths.

`@tediousjs/connection-string` is an existing package owned by this organisation that already parses SQL Server connection strings and supports composable schemas. v13 uses it as the single parsing path.

## Decision

**Core owns connection-string parsing.** `@tediousjs/mssql-core` depends on `@tediousjs/connection-string` and exposes `createClient(text, options?)` accepting either an options object or a connection string as the first argument.

**Each driver exports a schema** describing the keys it understands. Core merges the library schema (transport, credential, diagnostics) with the driver schema at parse time:

```ts
// in @tediousjs/mssql-tedious
export const tediousConnectionSchema: ConnectionStringSchema = {
  keys: {
    'encrypt': { type: 'boolean', target: 'transport.encrypt' },
    'trustServerCertificate': { type: 'boolean', target: 'transport.trustServerCertificate' },
    'applicationIntent': { type: 'enum', values: ['ReadOnly', 'ReadWrite'], target: 'transport.native.applicationIntent' },
    // ...
  },
  aliases: { 'Server': 'host', 'Data Source': 'host', /* ... */ },
}
```

**Unknown keys route to `transport.native`** — not dropped, not errored. A user who supplies a tedious-specific key on an msnodesqlv8 driver gets it passed through to `transport.native`, and the driver decides whether to honour or ignore it. This lets users migrate connection strings between drivers without losing information, and lets third-party drivers accept vendor-specific keys without a core change.

**Alias sets are merged**, not replaced. `Server` (ADO.NET) and `Data Source` (ODBC) both map to `host`. Adding a new alias is a driver change; the library schema covers the common ones.

**Usage**:

```ts
import { createClient } from '@tediousjs/mssql-core'
import { tedious } from '@tediousjs/mssql-tedious'

const sql = createClient(
  'Server=db.example.net;Database=app;Encrypt=true;TrustServerCertificate=false',
  { driver: tedious(), credential: { kind: 'tokenProvider', provider: getToken } }
)
```

The string and the options object are additive: string sets `transport`, options can override or supply things the string does not cover (credentials are usually options-only since you rarely want passwords in strings).

## Consequences

- One parsing path, one set of key names. Issues #1230 and #1400 close.
- Users can move from tedious to msnodesqlv8 without rewriting connection strings. Keys that only one driver understands go through `transport.native` and are honoured by the driver that recognises them.
- Third-party drivers can extend the schema by exporting their own. No core coordination needed.
- Library-level options (request timeout, app name, diagnostics opt-outs) can be set in the connection string consistently across drivers because they live in the library schema, not a driver schema.
- Connection-string *output* (serialisation) is deliberately out of scope. Users write config in code; serialising back to a string is a round-trip we do not need to support.
- `@tediousjs/connection-string` gains a downstream consumer that stresses its schema support. Changes to it need to be considered against this use.

## Alternatives considered

**Each driver parses independently** (v12 status quo). Rejected — it is the root cause of #1230 and #1400.

**Ban connection strings entirely, config-object only.** Considered. Rejected because connection strings are the universal currency for SQL Server ops — Azure portal outputs them, sysadmins paste them, CI secrets store them. Forcing users to parse them into objects themselves pushes the problem out of the library without solving it.

**Hardcode a fixed key list in core, ignore drivers' needs.** Rejected — the schema-merge approach lets drivers extend without core changes, which is necessary for the hexagonal architecture to hold. A fixed list would mean every new driver-specific key requires a core release.

**Reject unknown keys at parse time.** Considered. Rejected because it breaks the "paste a string and try a different driver" workflow. Routing unknown keys through `transport.native` is the pragmatic middle ground — drivers that recognise them honour them, drivers that do not ignore them (and can warn via diagnostics if they choose).

**Use an external generic parser (e.g. `dotenv`-style).** Rejected — SQL Server connection strings have specific quoting and escaping rules (`{`/`}` for values containing semicolons, for example) that a generic parser gets wrong. `@tediousjs/connection-string` handles these correctly.

## References

- [@tediousjs/connection-string](https://github.com/tediousjs/connection-string) — the parser core depends on.
- [ADR-0010: Driver port](0010-driver-port.md) — drivers expose `connectionStringSchema`.
- [ADR-0012: Credential and Transport abstractions](0012-credential-and-transport.md) — the types the parser targets.
- [tediousjs/node-mssql#1230](https://github.com/tediousjs/node-mssql/issues/1230) — inconsistent connection string parsing.
- [tediousjs/node-mssql#1400](https://github.com/tediousjs/node-mssql/issues/1400) — options silently dropped.
