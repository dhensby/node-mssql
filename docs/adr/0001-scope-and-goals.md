# ADR-0001: Scope and goals of the v13 rewrite

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

`mssql` (current major `12.x`) is a mature library but carries substantial legacy weight that no amount of incremental change will lift:

- Dual callback-and-promise APIs on every method doubles surface area and complicates every code path.
- `EventEmitter` is woven through Request, Transaction and Pool even for consumers who never touch streaming events.
- The pool library (`tarn`) is hardcoded; users cannot substitute their own pool without monkey-patching.
- There is no TypeScript source. Types are inferred from inline JSDoc with no compile-time guarantees.
- `ConnectionPool`, `Request`, `Transaction` and `PreparedStatement` each behave differently in subtle ways — `Promise.all` works on one but not the others, result shapes differ, lifecycle responsibilities are spread across all four.
- A module-level singleton pool couples every caller in a process together, which routinely causes test isolation problems.
- Six major ORMs (Drizzle, Kysely, TypeORM, Sequelize, Knex, and historically others) have independently reinvented the same workarounds — connection serialisation, pool-error handling, savepoint emulation via raw T-SQL, error code mapping. The library does not expose the primitives these consumers need.

Addressing these piecemeal has been tried. Each attempt has been constrained by the obligation not to break the callback surface or the singleton pool, which has systematically prevented meaningful change.

## Decision

v13 is a ground-up rewrite, not an incremental evolution. It replaces the public API, the internal architecture, and the test suite. It accepts a clean break from v12 in exchange for the freedom to design the library the way a modern Node/TypeScript SQL client should be designed.

The rewrite is guided by these goals, in order of priority:

1. **Promise-native, TypeScript-native.** No callback surface. Source in TypeScript. Strict types surfaced to consumers.
2. **Hexagonal architecture.** The library kernel knows nothing about TDS or ODBC; it talks to a `Driver` port. Drivers are swappable adapters.
3. **One queryable shape.** Pool, reserved connection, transaction, savepoint, prepared plan — all identical from the caller's perspective. `Promise.all` always works.
4. **Every handle is `AsyncDisposable`.** Forgetting to release a connection or commit a transaction is a type error, not a runtime leak.
5. **Modular packaging.** Core, drivers, pool adapter, and optional features (bulk, TVP) ship as separate `@tediousjs/mssql-*` packages under a meta `mssql` package that preserves the `npm i mssql` experience.
6. **Observability as a first-class concern.** `diagnostics_channel` replaces the `debug` dependency and the scattered EventEmitter traffic.
7. **Testability as a first-class concern.** The library is designed so consumers can write fast, deterministic integration tests using a transaction-per-test pattern without workarounds.

Explicit non-goals:

- **No v12 compatibility shim.** There will not be a `@tediousjs/mssql-compat-v12` package. The lifetime cost of a shim is higher than the benefit. v12 continues to be maintained; consumers migrate on their own schedule.
- **No dual CommonJS/ESM publishing.** ESM only.
- **No feature parity with v12 on day one.** TVPs, bulk load, and SQL CLR types are deferred to post-v13.0 package releases.

## Consequences

- Existing consumers of v12 cannot upgrade without code changes. This is acknowledged and accepted. A migration guide will be provided.
- The release cadence of v12 will slow as maintenance focus shifts to v13, but v12 will continue to receive security and bug fixes until v13 is stable.
- The rewrite is a multi-quarter effort. During that time `v12.x` on `latest` and `v13.0.0-next-major.*` on `next-major` will coexist on npm.
- Downstream ORMs that wrap the current library will need to either migrate or pin v12. This is an opportunity to offer them a cleaner driver-level integration.
- The breadth of the rewrite is high-risk. Risk is managed by (a) locking design decisions in ADRs before implementing, (b) prototyping the three highest-risk design points as throwaway spikes first, and (c) integration-testing everything against a real SQL Server from the first commit.

## Alternatives considered

**Incremental evolution within v12.** Attempted repeatedly. The callback surface and singleton pool make every non-trivial change a compatibility problem. Ruled out.

**A separate package (`mssql-next`, `@tediousjs/mssql-client`).** Considered because it avoids the `next-major` branch overhead. Rejected because it loses the accumulated npm trust, GitHub repo linking, and discoverability of the `mssql` package name.

**A slow rewrite on `master` behind feature flags.** Rejected because the kernel-level changes (tagged-template API, hexagonal driver port, ESM-only) cannot be flagged.

## References

- [ADR-0002: Same-repo `next-major` branch strategy](0002-branch-strategy.md)
- [ADR-0003: Runtime targets](0003-runtime-targets.md)
- [ADR-0004: Monorepo layout](0004-monorepo-layout.md)
- [ADR-0006: Unified queryable API](0006-queryable-api.md)
