# ADR-0005: Release process, CI workflows, and dependency automation

- **Status:** Proposed
- **Date:** 2026-04-25
- **Deciders:** @dhensby

## Context

The monorepo ([ADR-0004](0004-monorepo-layout.md)) needs an automated release pipeline that:

1. Calculates each package's version from the commits whose changed paths touch that package, using Conventional-Commit types to determine the bump level.
2. Generates a per-package changelog.
3. Publishes to GitHub releases and npm with provenance.
4. Runs without manual version input.
5. Fits the pre-release branch model ([ADR-0002](0002-branch-strategy.md)).
6. Supports independent per-package versioning, not lockstep ([ADR-0004](0004-monorepo-layout.md), Decision section).

`semantic-release`, the tool ADR-0002 originally assumed, has no native monorepo support — issue [semantic-release#1688](https://github.com/semantic-release/semantic-release/issues/1688) has been open since November 2020 with no official roadmap. The community plugins (`semantic-release-monorepo`, `multi-semantic-release`) either lock everything in lockstep or fragment each package into a separate semantic-release run with hand-tuned path filtering. Neither is a foundation we want to build on for a long-lived multi-package library.

We also need automated dependency updates across every workspace package's `package.json` (npm) plus the GitHub Actions versions, batching sympathetic updates so the PR queue stays manageable.

## Decision

### Pre-release branch

The v13 work lives on a long-lived branch named **`next-major`** in `tediousjs/node-mssql`. The name is inherited from the `semantic-release` default convention this repo was originally configured for. We are no longer using `semantic-release` for v13 (see "Release tooling" below), but the branch name is kept deliberately:

- `next-major` is a conventional name for "the next major version's pre-release branch" and communicates intent to contributors landing on the repo without further explanation.
- Branch lifecycle and merge semantics are owned by [ADR-0002](0002-branch-strategy.md); ADR-0002 is deliberately branch-name-agnostic so the choice stays reversible without invalidating that ADR.

### Release tooling: `release-please` in manifest mode

Run `release-please` via `googleapis/release-please-action` in *manifest mode* — the multi-package release model release-please was built for. Configuration lives in `.github/release-please-config.json`; current per-package versions live in `.release-please-manifest.json` (release-please writes to it on every release).

Rules:

- **Independent per-package versioning, by changed path.** release-please's manifest mode maps each package directory in `.github/release-please-config.json` to an `@tediousjs/mssql-*` package. Commits whose changed files fall under that directory contribute to that package's next version; commits that touch no package directory contribute to none. A commit that changes files in two package directories contributes to both. The Conventional-Commit *type* (`feat`/`fix`/`perf`/`!`) on each commit determines the bump level (minor/patch/patch/major).
- **One release PR per package.** When a branch has unreleased commits in a package's path, release-please opens or updates a `chore(<pkg>): release <version>` PR. Merging the PR cuts the tag, generates the changelog entry, and triggers a paired npm-publish job. No human is asked for a version number.
- **Per-package tags and changelogs.** Tags follow `<package-name>-v<version>` (e.g. `mssql-core-v13.2.0`). Each package owns its own `CHANGELOG.md`.
- **Phased pre-releases.** `prerelease: true` is set in release-please's config; the `prerelease-type` field drives the phase identifier (`alpha`, `beta`, `rc`). See the "Pre-release lifecycle" subsection below for what each phase signals and how transitions work.
- **The release-please job runs from day one.** It opens and updates release PRs throughout the rewrite so the changelog assembles in real time and the team can sanity-check what a release would look like at any point.
- **The npm-publish step is gated** behind a workflow conditional. While the gate is closed, release-please keeps release PRs up to date but no version is published to npm — useful during the rewrite to see what releases would look like without producing artefacts nobody can yet consume. The gate is lifted when we are ready to begin the alpha phase (see "Pre-release lifecycle"). The conditional is documented inline in `.github/workflows/release-next-major.yml` and is lifted by flipping a single boolean.
- **`master` continues to use `semantic-release`** for v12 maintenance until the v13.0 merge. After the merge, `master`'s release tooling switches to release-please as well, with the prerelease config swapped for stable.

### Conventional-Commit policy

Two distinct things drive release-please:

- **Commit type** — `feat:` / `fix:` / `perf:` / `!` (or `BREAKING CHANGE:` in the body) — determines the version bump (minor / patch / patch / major). Type is enforced in CI by commitlint.
- **Changed paths** — which files the commit modified — determine which package(s) are affected. release-please walks `git log` for each package's directory in `.github/release-please-config.json` and considers only commits that touched files there.

The conventional-commit **scope** is *not* what associates commits with packages — that is path-based, not message-based. Scope is a human-readable label that helps reviewers see at a glance which package a commit is intended to affect, and it groups changelog entries cleanly. We encourage scopes that match the package directory (e.g. `feat(core): …`, `fix(pool-tarn): …`) but **do not enforce them in CI**: a contributor who omits or mistypes the scope still gets a correct release because release-please reads the paths. The commitlint config deliberately omits a strict `scope-enum` rule — requiring contributors to memorise an exact scope vocabulary is friction we get nothing for.

Recommended scopes (match these to the directory the commit changes):

| Scope                  | Package directory                      |
|------------------------|----------------------------------------|
| `core`                 | `packages/core`                        |
| `driver-tedious`       | `packages/driver-tedious`              |
| `driver-msnodesqlv8`   | `packages/driver-msnodesqlv8`          |
| `pool-tarn`            | `packages/pool-tarn`                   |
| `meta`                 | `mssql/`                               |
| `release`, `deps`, `ci`, `docs`, `monorepo`, `adr` | non-package commits; typically touch no package directory and produce no version bump |

Cross-cutting changes that touch multiple package directories result in multiple packages being bumped automatically — there is no need to split such commits to "trigger" the right packages. Splitting is preferred for *changelog clarity*, not correctness. A coordinated cross-package break uses `!` or `BREAKING CHANGE:` and release-please majors every affected package together.

### Pre-release lifecycle

v13 ships through a phased pre-release sequence before stable. Each phase signals a different stability contract; the phase is encoded directly in the version, so consumers can read the version string and know what they are getting.

| Phase             | Version shape       | Stability contract                                                                                          |
|-------------------|---------------------|-------------------------------------------------------------------------------------------------------------|
| Alpha             | `13.0.0-alpha.N`    | Early access. APIs may still churn between alphas. For contributors and adventurous downstream library authors who want to give feedback. |
| Beta              | `13.0.0-beta.N`     | API surface frozen. Only bug fixes and documentation between betas. For early production trials by teams comfortable with new releases. |
| RC *(optional)*   | `13.0.0-rc.N`       | Release candidate. Blocker-only fixes. Used if the beta phase surfaces issues that warrant another round of validation; skipped if not needed. |
| Stable            | `13.0.0`            | General availability. Lands on the default `latest` dist-tag and becomes the recommended install for everyone. |

Each phase has a purpose: alphas exist to gather feedback, betas exist to flush out bugs once the API is set, RC (if needed) is a final go/no-go validation. Phase transitions (alpha → beta, beta → rc, rc → stable) are deliberate human acts — the maintainer changes `prerelease-type` in `.github/release-please-config.json` when the prior phase has run its course. There is no automatic graduation; a successful alpha does not silently become a beta.

**No consumer-facing dist-tag.** We deliberately do not maintain a stable dist-tag like `next` or `next-major` for consumers to install from. Pre-release identification belongs in the version itself — `13.0.0-alpha.0` says more than `mssql@next` does, and a tag pinned to "the latest pre-release" is a moving target that has bitten plenty of consumers in other ecosystems. Pre-releases are still published with `npm publish --tag <phase>` (alpha/beta/rc) at publish time, but only because npm requires *some* tag to keep them off `latest`; those tags are mechanical, not advertised. Consumers who want a pre-release install a specific version (`npm i mssql@13.0.0-alpha.0`) or pin a range (`npm i mssql@~13.0.0-alpha`).

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
- **Conventional-Commit type discipline is enforced in CI** via commitlint. Scope discipline is recommended (matching scopes to package directories aids changelog readability) but not enforced — release routing depends on changed paths, not on the message scope. Existing commit history on `next-major` already follows the convention by habit; type drift is a commitlint failure, but a typo or omitted scope is harmless.
- **Pre-releases follow a phased alpha → beta → rc → stable lifecycle**, with the phase encoded in the version (`13.0.0-alpha.N`, `13.0.0-beta.N`, `13.0.0-rc.N`). Consumers install by version, not by a stable dist-tag — see "Pre-release lifecycle" above.
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
- [ADR-0002: Same-repo pre-release branch strategy](0002-branch-strategy.md)
- [ADR-0004: Monorepo with npm workspaces](0004-monorepo-layout.md)
