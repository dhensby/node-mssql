# Contributing to node-mssql

Thanks for your interest in contributing! `node-mssql` is a Microsoft SQL Server client for Node.js — written in TypeScript, shipped as ESM, and laid out as a monorepo of a driver-agnostic core plus driver adapters (see [Repository layout](#repository-layout)). Design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/); start with [ADR-0001](docs/adr/0001-scope-and-goals.md) for scope and goals.

## Table of contents

- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Building](#building)
- [Testing](#testing)
- [Linting](#linting)
- [Commit conventions](#commit-conventions)
- [Branching & pull requests](#branching--pull-requests)
- [Architecture & conventions](#architecture--conventions)

## Prerequisites

- **Node.js `>= 20.3.0`** — the supported floor, set in every package's `engines.node` ([ADR-0003](docs/adr/0003-runtime-targets.md)). The lint rules enforce it: anything newer than the floor is flagged (see [MODERNIZE](#runtime-floor--modernize) below). Coverage uses Node's built-in test-coverage flags, which stabilised in **Node 22**, so run coverage on Node 22+. CI exercises the matrix on Node 20.x, 22.x, and 24.x.
- **npm** (the repo uses npm workspaces — no other package manager is configured).
- **Docker** — only needed to run the driver integration tests against a real SQL Server (see [Testing](#testing)).

A VS Code **dev container** is provided (`.devcontainer/`): "Reopen in Container" gives you a ready toolchain and runs `npm install` automatically.

## Getting started

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/node-mssql.git
cd node-mssql
npm install                    # installs all workspaces
npm run build:workspaces       # tsc -b across every package
npm run test:workspaces        # unit tests across every package
```

## Repository layout

A monorepo of independently-versioned packages under `packages/*` ([ADR-0004](docs/adr/0004-monorepo-layout.md)):

| Path | Package | Role |
|------|---------|------|
| `packages/core` | `@tediousjs/mssql-core` | Driver-agnostic kernel — the `sql` tag, `Query`, pool/client, error taxonomy. Depends on no SQL driver. |
| `packages/tedious` | `@tediousjs/mssql-tedious` | The [tedious](https://github.com/tediousjs/tedious) driver adapter implementing core's driver port ([ADR-0010](docs/adr/0010-driver-port.md)). |

Other notable directories:

- `docs/adr/` — Architecture Decision Records. **The design record.** Start with [`docs/adr/README.md`](docs/adr/README.md) for the index; use [`docs/adr/template.md`](docs/adr/template.md) when adding one.
- `.github/workflows/` — CI (`nodejs.yml`) and release automation.

## Building

Each package compiles with `tsc -b`. From the repo root:

```bash
npm run build:workspaces       # build every package
```

Or per package:

```bash
cd packages/core && npm run build
```

## Testing

Tests use the **built-in `node:test` runner** (no external test framework) and `node:test`'s `mock.fn` for fakes. Test sources compile to `dist-test/` via `tsc -b tsconfig.test.json` before running.

### Unit tests

`*.test.ts` files. Fast, hermetic, no network — drivers/connections are faked.

```bash
npm run test:workspaces        # all packages (from repo root)
# or per package:
cd packages/core && npm test
```

### Integration tests (live SQL Server)

`*.int.ts` files, in the driver packages. They run end-to-end against a **real SQL Server** and **fail loudly if one is not reachable** — there is no silent skip, so "the integration suite passed" means it passed against a real database.

The repo ships a `docker-compose.yml` that starts a local server matching the test defaults (it uses `azure-sql-edge` so it also runs natively on Apple silicon / ARM64):

```bash
docker compose up -d           # from repo root; healthcheck-gated, ready in ~30s
cd packages/tedious            # a driver package
MSSQL_TEST_PASSWORD='yourStrong(!)Password' npm run test:int
docker compose down -v         # tear down (from repo root)
```

Connection details come from `MSSQL_TEST_*` env vars (see [`packages/tedious/test/integration.ts`](packages/tedious/test/integration.ts)):

| Variable | Default | |
|----------|---------|---|
| `MSSQL_TEST_PASSWORD` | — | **required** (the SA password) |
| `MSSQL_TEST_HOST` | `localhost` | |
| `MSSQL_TEST_PORT` | `1433` | |
| `MSSQL_TEST_USER` | `sa` | |
| `MSSQL_TEST_DATABASE` | `master` | |

Override any of them to point at a different server. The compose file's SA password defaults to `yourStrong(!)Password` but honours `MSSQL_TEST_PASSWORD` if exported, so exporting it once configures both the container and the tests.

### Coverage

```bash
npm run test:coverage:workspaces   # Node 22+; thresholds: lines 80, functions 80, branches 70
```

Coverage is global per package, not per file. **A driver package's coverage run includes its integration tests**, so it needs a reachable SQL Server (and the `MSSQL_TEST_PASSWORD` env) — the same gate CI's coverage job runs.

## Linting

ESLint flat config ([`eslint.config.js`](eslint.config.js)) with `typescript-eslint` and `@stylistic` — tabs, single quotes, semicolons, trailing commas in multiline. Type errors are caught at build time (`tsc -b`), not by the linter.

```bash
npm run lint:packages              # check
npm run lint:packages -- --fix     # auto-fix what's fixable
```

Lint must pass before you commit — it's a CI gate.

## Commit conventions

Commits follow [**Conventional Commits**](https://www.conventionalcommits.org/) and are checked in CI by commitlint (`@commitlint/config-conventional`). Pre-check locally:

```bash
npm run commitlint                 # check commit messages against the convention
```

The **type** drives the release bump; the **changed paths** drive which package is released ([ADR-0005](docs/adr/0005-release-and-ci.md)) — a commit under `packages/core/` versions `@tediousjs/mssql-core`. A cross-cutting commit bumps every package it touches; split commits for changelog clarity, not to "trigger" a package.

| Type | Effect |
|------|--------|
| `feat:` | minor bump |
| `fix:` / `perf:` | patch bump |
| `feat!:` / `BREAKING CHANGE:` | major bump |
| `refactor:` `docs:` `test:` `chore:` `ci:` `style:` `build:` | no release |

Guidelines:

- **Atomic and individually deployable.** One logical change per commit; don't mix a fix with an unrelated refactor.
- **Changelog sniff test.** Before `feat`/`fix`/`perf`, ask "does this read as a changelog line?" A bug in an unreleased feature is part of that feature, not a standalone `fix:` — fold it in rather than emitting a changelog entry for it.
- **Sign your commits** (`git commit -S`) if you have signing set up.

## Branching & pull requests

- **Base your work on `master`** and open your PR against it.
- **Keep PRs focused** — a reviewable, coherent change is easier to land than a sprawling one.
- **Manage your branch however you like.** Rebase, amend, fixup commits, or follow-up commits in response to review are all fine — it's your branch; just get it to a state you're happy to have merged, with each commit following the [commit conventions](#commit-conventions) above.
- **CI must be green:** build, unit + integration tests, and coverage on Node 20/22/24, plus lint and commitlint.

## Architecture & conventions

Significant design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/). If a change alters a public contract or makes a non-obvious structural choice, add or update an ADR ([`template.md`](docs/adr/template.md)) alongside the code. The conventions this project follows:

### Hexagonal driver port

`@tediousjs/mssql-core` knows nothing about any SQL driver; drivers implement the driver port and the pool port ([ADR-0010](docs/adr/0010-driver-port.md), [ADR-0011](docs/adr/0011-pool-port.md)). New driver behaviour belongs behind the port.

### Error taxonomy

Every library error extends `MssqlError`, so one `instanceof MssqlError` catches them all and each carries correlation ids ([ADR-0017](docs/adr/0017-error-taxonomy.md)). Throw the specific subclass (`QueryError`, `ConnectionError`, `StateError`, …). Reserve plain `TypeError` for genuine argument/type errors (an unsupported parameter JS type, an invalid identifier); use `StateError` for "you called this in a state that forbids it" (a tag on a released connection, a terminal on a consumed `Query`).

### Lifecycle state & idempotent settlement

Lifecycle objects use the shared `createStateMachine` / `onceAsync` primitives ([ADR-0024](docs/adr/0024-lifecycle-state-and-idempotent-settlement.md)). In conditions use the `is()` / `!is()` helpers; read `.state` only when you need the current value as data (e.g. an error payload), not to branch on it.

### Runtime floor & MODERNIZE

The code targets the `engines.node` floor; `eslint-plugin-n` flags any runtime built-in newer than it (src only — tests run on the dev/CI Node). When you must reach for a newer API, either raise the floor or polyfill it and tag the polyfill so a floor bump is one grep away from everything to revisit:

```ts
// MODERNIZE(node>=22): delete this module and call the native Promise.withResolvers()
```

### Tests

`*.test.ts` are hermetic unit tests (drivers faked via `mock.fn`); `*.int.ts` are live-server integration tests. Phrase assertion messages as the **failure-useful expectation** — "failed connection should leave client destroyed", not a description of the success state or `expect`-style prose.

### TypeScript & ESM

ESM-only, TypeScript strict (`noUncheckedIndexedAccess` on). Relative imports carry the `.js` extension (`./foo.js`), matching ESM resolution of the compiled output.
