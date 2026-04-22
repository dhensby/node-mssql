# ADR-0005: Release process, CI workflows, and dependency automation

- **Status:** Proposed
- **Date:** 2026-04-25
- **Deciders:** @dhensby

## Context

The monorepo ([ADR-0004](0004-monorepo-layout.md)) needs an automated release pipeline that:

1. Calculates each package's version from its own commit history (Conventional Commits scoped to package).
2. Generates a per-package changelog.
3. Publishes to GitHub releases and npm with provenance.
4. Runs without manual version input.
5. Fits the `next-major` pre-release branch model ([ADR-0002](0002-branch-strategy.md)).
6. Supports independent per-package versioning, not lockstep ([ADR-0004](0004-monorepo-layout.md), Decision section).

`semantic-release`, the tool ADR-0002 originally assumed, has no native monorepo support — issue [semantic-release#1688](https://github.com/semantic-release/semantic-release/issues/1688) has been open since November 2020 with no official roadmap. The community plugins (`semantic-release-monorepo`, `multi-semantic-release`) either lock everything in lockstep or fragment each package into a separate semantic-release run with hand-tuned path filtering. Neither is a foundation we want to build on for a long-lived multi-package library.

We also need automated dependency updates across every workspace package's `package.json` (npm) plus the GitHub Actions versions, batching sympathetic updates so the PR queue stays manageable.

## Decision

### Release tooling: `release-please` in manifest mode

Run `release-please` via `googleapis/release-please-action` in *manifest mode* — the multi-package release model release-please was built for. Configuration lives in `.github/release-please-config.json`; current per-package versions live in `.release-please-manifest.json` (release-please writes to it on every release).

Rules:

- **Independent per-package versioning.** Each package's version is computed from Conventional-Commit messages whose scope matches the package directory:
  - `feat(core): …` → bumps `@tediousjs/mssql-core`.
  - `fix(driver-tedious): …` → bumps `@tediousjs/mssql-tedious`.
  - `feat(pool-tarn): …` → bumps `@tediousjs/mssql-tarn`.
  - `feat(meta): …` → bumps the meta `mssql` package.
- **One release PR per package.** When a branch has unreleased commits in a package's path, release-please opens or updates a `chore(<pkg>): release <version>` PR. Merging the PR cuts the tag, generates the changelog entry, and triggers a paired npm-publish job. No human is asked for a version number.
- **Per-package tags and changelogs.** Tags follow `<package-name>-v<version>` (e.g. `mssql-core-v13.2.0`). Each package owns its own `CHANGELOG.md`.
- **Pre-release on `next-major`.** Configured via `prerelease: true` and `prerelease-type: "next-major"`, producing versions like `13.0.0-next-major.N`. The npm dist-tag remains `next-major`; consumers opt in with `npm i mssql@next-major`.
- **The release-please job runs from day one on `next-major`.** It opens and updates release PRs throughout the rewrite so the changelog assembles in real time and the team can sanity-check what a release would look like at any point.
- **The npm-publish step is gated** behind a workflow conditional and does not fire until v13 is ready for early adopters. See [ADR-0002](0002-branch-strategy.md) for the broader gate. The conditional is documented inline in `.github/workflows/release-next-major.yml` and is lifted by removing it (or flipping a single boolean).
- **`master` continues to use `semantic-release`** for v12 maintenance until the v13.0 merge. After the merge, `master`'s release tooling switches to release-please as well, with the prerelease config swapped for stable.

### Conventional-Commit scope policy

Scopes map directly to package directories:

| Scope                  | Package                              |
|------------------------|--------------------------------------|
| `core`                 | `@tediousjs/mssql-core`              |
| `driver-tedious`       | `@tediousjs/mssql-tedious`           |
| `driver-msnodesqlv8`   | `@tediousjs/mssql-msnodesqlv8`       |
| `pool-tarn`            | `@tediousjs/mssql-tarn`              |
| `meta`                 | `mssql` (umbrella package)           |
| `release`, `deps`, `ci`, `docs`, `monorepo`, `adr` | non-package; no version bump |

`feat`/`fix`/`perf` commits **must** carry a package scope. `chore`/`ci`/`docs`/`refactor`/`test` may use either a package scope or a non-package scope. Cross-cutting changes either split into multiple commits or use `BREAKING CHANGE:` / `!` if a coordinated cross-package break is intended; release-please will then bump every affected package as a major together.

The commitlint config enforces this via `scope-enum`.

### Meta package dependency pinning

The `mssql` meta package uses **caret ranges** (`^13.x.y`) on its `@tediousjs/mssql-*` deps, not exact pins. The npm resolver is free to pick up patch and minor updates without forcing a meta republish. When a material change warrants a new meta floor (e.g. a new feature in `mssql-core` that the meta should expose by default), the floor is bumped explicitly via a `feat(meta):` or `fix(meta):` commit. This keeps the meta's release cadence honest without over-pinning.

### CI workflow layout

Workflows live in `.github/workflows/`:

- `nodejs.yml` — existing build/test/release workflow. Continues to handle `master` builds and v12's `semantic-release` release job. The `next-major` exclusion on the existing `release` job stays.
- `release-next-major.yml` — new workflow. Runs `release-please` on every push to `next-major` to open/update release PRs. The npm-publish job is gated.
- `gh-pages.yml` — existing docs publish, unchanged.

When v13 ships and `next-major` is merged into `master` ([ADR-0002](0002-branch-strategy.md)), the `master` release switches from `semantic-release` to `release-please`. Either by replacing the `release` job in `nodejs.yml` or by promoting `release-next-major.yml` to `release.yml` with the prerelease config swapped for stable.

### Dependency automation: Dependabot

`.github/dependabot.yml` covers:

- **npm ecosystem**, plural-`directories` form: `["/", "/packages/*", "/mssql"]` (the `mssql` directory is added when the meta package bootstraps). New `packages/<dir>` entries are picked up automatically by the glob — no per-package config maintenance.
- **GitHub Actions ecosystem** at `/`.
- **Sympathetic groups**: all `@types/*`, all `@commitlint/*`, all release-please action updates batched together. TypeScript / `@typescript-eslint/*` grouped. Test framework grouped (`mocha` and friends). This keeps the PR queue manageable.
- **`target-branch: next-major`** for the v13 entries during the rewrite period, so dependabot opens PRs against `next-major` rather than `master`. v12-only entries (root) stay on the default branch.

A practical caveat: Dependabot reads its config from the repository's **default branch** (currently `master`). For Dependabot to actually start opening PRs against `next-major` workspace packages, the same `.github/dependabot.yml` change must also land on `master` (a small dedicated PR is the simplest path). The change on `next-major` makes the config correct for when v13 merges into master; the change on `master` makes it active during the rewrite period.

## Consequences

- **Independent versioning means honest version numbers.** A `fix(pool-tarn): …` commit bumps only `@tediousjs/mssql-tarn`. `mssql-core` does not republish for a pool-adapter fix it had no part in.
- **The meta `mssql` package republishes only when a `feat(meta):` / `fix(meta):` warrants it.** Caret-range absorption of upstream patch/minor releases happens at install time without a republish.
- **Per-package changelogs** make per-package release notes easy to find. Users tracking only `mssql-core` see only its history.
- **Conventional-Commit scope discipline becomes a hard requirement** enforced in CI. Existing commit history on `next-major` already follows this convention; any drift is a commitlint failure.
- **Pre-release versions on `next-major` are `13.0.0-next-major.N`** — same shape `semantic-release` would have produced. The `next-major` dist-tag is preserved; consumers' `npm i mssql@next-major` story is unchanged.
- **Dependabot covers every workspace package automatically as new ones bootstrap.** No per-package config maintenance required — the `/packages/*` glob handles it.
- **The Dependabot config landing on `next-major` only takes effect once it also lands on `master`.** A one-time sync; once both branches carry the same config, workspace updates flow correctly. Documented above.
- **Switching `master` from semantic-release to release-please at v13.0 merge time is a planned migration**, not a surprise. The v12 changelog generated by semantic-release stays intact; release-please picks up from the v13.0 tag forward.
- **The release PR workflow has a small human step** (merging the PR) that semantic-release's "every push releases" model didn't. We treat that as a feature, not a bug — a maintainer eyeballs the proposed changelog before it hits npm.

## Alternatives considered

**`semantic-release` with `semantic-release-monorepo` plugin.** Rejected. Issue 1688 has been open since 2020 with no official path. The community plugins have correctness issues with cross-package commits and dep version updates, and the design forces a choice between lockstep and fragile per-package path-scoping. Building a long-lived release pipeline on third-party plugins that the upstream tool actively rejects is not a foundation we want.

**`@changesets/cli`** (used by pnpm, Astro, Remix, Apollo, Tailwind UI). Considered. Rejected because it adds per-PR developer friction: every PR that affects a package must include a `.changeset/*.md` file declaring which packages changed and at what bump level. For a small core team already disciplined about Conventional Commits, release-please's commit-driven model is lower friction with the same end result. If we ever want maintainer-curated release notes (rather than commit-driven), changesets is the better tool — but that is not the requirement.

**`release-it`** (used by `node-redis`). Rejected — fails the "full automation" requirement. `release-it` requires a maintainer to manually trigger a workflow with a pre-determined version, which is error-prone and surfaces version-bump decisions to humans that conventional-commit-driven tooling makes deterministically.

**Nx Release.** Rejected. We don't use Nx for the build, and adopting it just for releases is overkill ([ADR-0004](0004-monorepo-layout.md) already rejected Nx as a build tool).

**Strict version lockstep across all packages** (the original ADR-0004 stance). Reconsidered: every package republishing on every change makes version numbers dishonest (a `fix(pool-tarn)` should not bump `core` from 13.0.5 to 13.0.6 unchanged), churns every consumer's lockfile, and provides convenience-for-us at cost-to-them. Independent versioning with the meta package using caret ranges accomplishes the same compatibility guarantee without the noise. ADR-0004's Decision section is amended to match.

**`linked-versions` plugin to lockstep just `core` + `meta`.** Considered as a compromise — keep the kernel and the umbrella in sync so users have a single "v13 line" version to reason about. Rejected for now: it reintroduces the same dishonest-version-numbers problem on a smaller scale, and the meta package's caret ranges already give users the "one number to install" ergonomic. Easy to add later via `linked-versions` config if it proves useful.

## References

- [release-please](https://github.com/googleapis/release-please) — main repo and docs.
- [release-please manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) — manifest-mode configuration reference.
- [release-please-action](https://github.com/googleapis/release-please-action) — the GitHub Action.
- [semantic-release issue #1688](https://github.com/semantic-release/semantic-release/issues/1688) — the still-open monorepo support thread.
- [Dependabot configuration reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- [ADR-0002: Same-repo `next-major` branch strategy](0002-branch-strategy.md)
- [ADR-0004: Monorepo with npm workspaces](0004-monorepo-layout.md)
