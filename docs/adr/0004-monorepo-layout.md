# ADR-0004: Monorepo with npm workspaces and `@tediousjs/mssql-*` scope

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

The v13 architecture ([ADR-0001](0001-scope-and-goals.md)) requires separating the kernel from drivers and from optional features. Users need three things to work:

1. `npm i mssql` keeps producing a working, batteries-included library — the zero-config user should not notice the packaging split.
2. Power users can pick their own driver, pool adapter, or strip features they do not need.
3. Third parties can publish additional drivers or optional packages that plug into the same kernel without forking.

`node-redis` solves an almost identical problem with an npm-workspaces monorepo. Its layout is a known-good reference point.

## Decision

Single repository, **npm workspaces**, packages under `packages/` with scope **`@tediousjs/mssql-*`**. A meta package `mssql` (unscoped) depends on the default driver and pool and re-exports the kernel.

Initial layout:

```
packages/
  core/                  -> @tediousjs/mssql-core
  driver-tedious/        -> @tediousjs/mssql-tedious
  driver-msnodesqlv8/    -> @tediousjs/mssql-msnodesqlv8
  pool-tarn/             -> @tediousjs/mssql-tarn
  test-harness/          -> @tediousjs/mssql-test-harness   (private, not published)
mssql/                   -> meta package, re-exports core + default driver + default pool
```

Later additions (TVP, bulk, sqlcmd, testing mocks) will each be a new `packages/*` entry. No package splits the kernel; `@tediousjs/mssql-core` is the one kernel.

Rules:

- **npm workspaces** (not pnpm, Yarn, Turborepo, Nx, Lerna). Prefer native Node and npm tooling over third-party tooling when the native option meets our needs; no `packageManager` field required; contributors do not need to install any additional CLI.
- **Drivers declare `@tediousjs/mssql-core` as a peer dependency**, not a regular dependency. This guarantees a single shared copy of core at install time, so `instanceof` checks on error classes work across the library boundary. See [ADR-0017](0017-error-taxonomy.md).
- **Private test-harness package**, never published. Shared infrastructure that all packages use for integration tests.

## Consequences

- `npm i mssql` continues to work unchanged for zero-config users.
- Power users do `npm i @tediousjs/mssql-core @tediousjs/mssql-msnodesqlv8 @tediousjs/mssql-tarn` and configure their client directly. Meta package becomes optional.
- Tree-shaking and install-size win: a user who wants only tedious does not install msnodesqlv8's native binary, and vice versa.
- New drivers can ship as third-party packages — the shape is exactly what first-party drivers use.
- Users with multiple copies of core installed (e.g. via `npm link`) will encounter `instanceof` identity problems. Peer-dep discipline and a CI check that drivers have no direct dep on core mitigate this.

## Alternatives considered

**pnpm workspaces.** Considered because `workspace:*` is ergonomic and the CLI is fast. Rejected on the broader principle that we prefer npm and Node native tooling over third-party tooling when the native option meets our needs. npm workspaces covers the monorepo features we need (linked packages, cross-package scripts, workspace-aware install); taking on pnpm adds a required non-standard tool to every contributor's machine and to CI for a marginal ergonomic gain. The fact that `node-redis` ships a substantial monorepo on npm workspaces is a signal that this route is viable at our scale.

**Turborepo / Nx.** Overkill for a library with two build targets (tsc + tests). Rejected.

**One mega-package.** Rejected — the goal is to let users pick drivers and features, and to let third parties extend the library. Monolithic packaging defeats both.

**Scope `@mssql/*`.** Rejected — the `@mssql` npm scope is not available to us (likely trademarked or occupied). `@tediousjs/` is the organisational scope we already own.

## References

- [node-redis packages directory](https://github.com/redis/node-redis/tree/master/packages) — reference for layout patterns. Note: node-redis ships in lockstep; we deliberately diverge — see [ADR-0005](0005-release-and-ci.md).
- [npm workspaces docs](https://docs.npmjs.com/cli/using-npm/workspaces)
- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
- [ADR-0005: Release process, CI workflows, and dependency automation](0005-release-and-ci.md)
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md)
