# Architecture Decision Records

This directory captures durable design decisions for the v13 rewrite.

Each ADR is a short (~1 page) record of a decision we've made and *why*, intended to be useful to a future contributor — or future self — six months from now. They are deliberately lightweight: if an ADR takes more than fifteen minutes to write, it is probably covering more than one decision.

## When to write one

- A design choice that affects the public API, the driver port, or cross-package contracts.
- A choice between plausible alternatives where later readers would benefit from knowing why we picked one.
- Anything irreversible or expensive to reverse.

## When not to write one

- Tactical implementation details that live in code comments or PR descriptions.
- Decisions scoped to a single file or function.
- Things that are obvious from the code itself.

## Conventions

- File name: `NNNN-kebab-case-title.md`, zero-padded to 4 digits.
- Numbering is monotonic across the project. Never renumber existing ADRs.
- Status is one of: **Proposed**, **Accepted**, **Superseded by ADR-XXXX**, **Deprecated**.
- When an ADR is superseded, update its status line but keep the file — history matters.
- Cross-reference other ADRs by number.

## Index

- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
- [ADR-0002: Same-repo pre-release branch strategy](0002-branch-strategy.md)
- [ADR-0003: Runtime targets — ESM, TypeScript 6+, Node 20+](0003-runtime-targets.md)
- [ADR-0004: Monorepo with npm workspaces and `@tediousjs/mssql-*` scope](0004-monorepo-layout.md)
- [ADR-0005: Release process, CI workflows, and dependency automation](0005-release-and-ci.md)
- [ADR-0006: Unified queryable API with cardinality terminals](0006-queryable-api.md)
- [ADR-0007: Query result presentation — column metadata, raw rows, duplicates, trailer data, and side channels](0007-query-result-presentation.md)
- [ADR-0008: Query lifecycle and disposal — laziness, exit paths, and `await using`](0008-query-lifecycle-and-disposal.md)
- [ADR-0009: Stored procedures and prepared statements as re-executable templates](0009-stored-procedures-and-prepared-statements.md)
- [ADR-0010: Driver port — hexagonal boundary between kernel and wire protocol](0010-driver-port.md)
- [ADR-0011: Pool port — pooling as an optional, swappable adapter](0011-pool-port.md)
- [ADR-0012: Credential and Transport abstractions](0012-credential-and-transport.md)
- [ADR-0013: Cancellation and timeouts via AbortSignal](0013-cancellation-and-timeouts.md)
- [ADR-0014: Diagnostics via `diagnostics_channel`](0014-diagnostics.md)
- [ADR-0015: Connection string parsing](0015-connection-strings.md)
- [ADR-0016: Object ID format](0016-object-id-format.md)
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md)
- [ADR-0018: Client lifecycle — `createClient`, `connect`, `close`, `destroy`](0018-client-lifecycle.md)
- [ADR-0019: SQL type system and type tags](0019-sql-type-system.md) *(draft)*
- [ADR-0020: Table-valued parameters](0020-table-valued-parameters.md) *(draft)*
- [ADR-0021: Bulk insert / bulk load](0021-bulk-insert.md) *(draft)*
- [ADR-0022: Per-Query lifecycle event surface](0022-per-query-event-surface.md) *(draft)*
- [ADR-0023: `RequestRunner` — connection acquisition for `Query<T>`](0023-request-runner.md) *(draft)*
