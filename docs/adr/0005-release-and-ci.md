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

The v13 work lives on a long-lived branch named **`next-major`** in `tediousjs/node-mssql`. The name is inherited from the `semantic-release` default convention this repo was originally configured for; although v13 work no longer uses `semantic-release` (see "Release tooling" below), `next-major` is a conventional name across the npm ecosystem for "the next major version's pre-release branch" and communicates intent to contributors landing on the repo without further explanation.

### Release tooling: `release-please` in manifest mode

Run `release-please` via `googleapis/release-please-action` in **manifest mode**. Manifest mode is release-please's multi-package configuration model: instead of treating the repo as one package and inferring everything from the root, two files describe the layout explicitly.

- `.github/release-please-config.json` — declares each package: its path under `packages/` (or `mssql/` for the meta), its release type (`node`), its prerelease and changelog options. Maintained by hand.
- `.release-please-manifest.json` — records the current released version of each package. release-please writes to it as part of every release PR; it is the source of truth for "what version is each package on right now".

The alternative ("simple" mode) treats the repo as one package and does not support independent per-package versions, which is incompatible with the monorepo ([ADR-0004](0004-monorepo-layout.md)).

Rules:

- **Independent per-package versioning, by changed path.** release-please's manifest mode maps each package directory in `.github/release-please-config.json` to an `@tediousjs/mssql-*` package. Commits whose changed files fall under that directory contribute to that package's next version; commits that touch no package directory contribute to none. A commit that changes files in two package directories contributes to both. The Conventional-Commit *type* (`feat`/`fix`/`perf`/`!`) on each commit determines the bump level (minor/patch/patch/major).
- **One release PR per package.** When a branch has unreleased commits in a package's path, release-please opens or updates a `chore(<pkg>): release <version>` PR. Merging the PR cuts the tag, generates the changelog entry, and triggers a paired npm-publish job. No human is asked for a version number.
- **Per-package tags and changelogs.** Tags follow `<package-name>-v<version>` (e.g. `mssql-core-v13.2.0`). Each package owns its own `CHANGELOG.md`.
- **Phased pre-releases.** `prerelease: true` is set in release-please's config; the `prerelease-type` field drives the phase identifier (`alpha`, `beta`, `rc`). See the "Pre-release lifecycle" subsection below for what each phase signals and how transitions work.
- **The release-please workflow is gated until we begin the alpha phase.** The workflow file lives in the repo, but the entire job (release PR generation and npm-publish) is wrapped in a workflow conditional that defaults to off. While off, release-please does not run on push — no release PRs accumulate and nothing publishes to npm. The gate is flipped on when the project has made enough progress that cutting alpha releases makes sense (see "Pre-release lifecycle"). The conditional is documented inline in `.github/workflows/release-next-major.yml` and is flipped by changing a single boolean.
- **`master` continues to use `semantic-release`** for v12 maintenance until the v13.0 merge. After the merge, `master`'s release tooling switches to release-please as well, with the prerelease config swapped for stable.

### Conventional-Commit policy

Two distinct things drive release-please:

- **Commit type** — `feat:` / `fix:` / `perf:` / `!` (or `BREAKING CHANGE:` in the body) — determines the version bump (minor / patch / patch / major). Type is enforced in CI by commitlint.
- **Changed paths** — which files the commit modified — determine which package(s) are affected. release-please walks `git log` for each package's directory in `.github/release-please-config.json` and considers only commits that touched files there.

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

**Pre-release dist-tag: `next`.** All pre-releases — alpha, beta, and rc — publish under the **`next`** npm dist-tag. `next` is the [npm-canonical convention](https://docs.npmjs.com/cli/v8/commands/npm-dist-tag#purpose) for "the next major version's pre-release" and is the right default here for two reasons: `npm publish` requires *some* `--tag` to keep pre-release versions off the `latest` tag, and consumers who want to track pre-releases benefit from a single stable install command across the whole lifecycle. `npm i mssql@next` always resolves to the most recent pre-release, whether that is currently an alpha, a beta, or an rc. Consumers who want a specific phase or a pinned version install by exact version (e.g. `npm i mssql@13.0.0-alpha.0`) or by range (`npm i mssql@~13.0.0-alpha`). The phase identifier in the version (`-alpha.N`, `-beta.N`, `-rc.N`) is the source of truth for stability; the dist-tag is install convenience.

When v13 reaches stable, the `next` dist-tag is removed (`npm dist-tag rm mssql next`) so it does not linger as a stale pointer to the last published pre-release. Removing the tag is part of the v13.0 release procedure, not something release-please does automatically.

### Meta package dependency pinning

The `mssql` meta package pins **exact versions** of every `@tediousjs/mssql-*` dependency, and republishes whenever any of those dependencies republishes. Release-please's `node-workspace` plugin handles the mechanics: when a workspace dep's version changes, the plugin rewrites the meta's `package.json` in the same release PR, which release-please then treats as a change to `mssql/` and bumps the meta accordingly.

Why exact pins:

1. **Reproducibility for bug reports.** A `mssql@13.2.4` install resolves to exactly one set of sub-package versions. A user can paste the meta version into an issue and we know precisely what they have.
2. **Crystallised fix sets.** Each meta release captures the set of fixes shipped in its sub-packages at that moment. Upgrading the meta picks up a known fix bundle, not a moving target resolved at install time.
3. **Deliberate major handling.** A sub-package going to a new major requires the meta to opt in by editing the pin. Caret ranges would either silently absorb a sub-package major or (with `^0.x` semantics) be too conservative; neither is what we want. Exact pins make the meta's major-bump moments explicit and reviewable.
4. **Canonical roll-up changelog.** The meta's release notes summarise the sub-package version changes that triggered the bump. Sub-packages keep their own detailed changelogs; the meta's is the umbrella view that upgrade tooling and human readers can follow without traversing every sub-package.

**Lockfile updates.** release-please's `node-workspace` plugin updates the root `package-lock.json` alongside the per-package `package.json` updates in the release PR. As a guardrail, the release PR's CI runs `npm install --package-lock-only` and fails if that produces drift from what release-please wrote; if drift ever appears, an operator runs `npm install` and pushes the result before merging. This guards against the historical edge case where lockfile updates lagged dep updates in npm-workspaces monorepos ([release-please#1993](https://github.com/googleapis/release-please/issues/1993), since fixed).

**Cross-package atomicity.** A fix that touches multiple sub-packages produces one release PR per affected sub-package plus a meta release PR. The `node-workspace` plugin re-renders the meta PR each time a sub-package release PR merges, so the meta PR's pins always reflect the latest published versions of every sub-package. The merge order for an atomic cross-package fix is therefore:

1. Merge each affected sub-package's release PR (order does not matter; each publishes independently).
2. Once all of them have published, merge the meta release PR — it will pin the new versions of every affected sub-package together.

A maintainer who merges the meta release PR after the first sub-package publishes but before the others have would publish a meta version with mixed pins (some sub-packages on the new fix, some on the prior version). This is operator discipline, not tooling-enforced. The mitigation is a documented release procedure (in `RELEASING.md`) plus a meta-release PR template that surfaces the currently-open sub-package release PRs and asks the maintainer to confirm they have all merged before merging the meta. A stronger CI gate — block the meta publish job if any other release-please PR is open — is deferred until real-world experience shows the procedure alone is insufficient.

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

- **Independent versioning means honest version numbers.** A change confined to `packages/pool-tarn/` bumps only `@tediousjs/mssql-tarn`. `mssql-core` does not republish for a pool-adapter fix it had no part in.
- **The meta `mssql` package republishes whenever a `@tediousjs/mssql-*` dependency republishes.** Exact pins on the meta's deps mean every sub-package release triggers a meta release in the same release PR. See "Meta package dependency pinning" above for why.
- **Cross-package fixes land atomically on the meta when the merge order is followed.** A fix touching multiple sub-packages produces one release PR per affected sub-package plus a meta PR; merging all sub-package PRs first and the meta PR last results in a single meta version that pins the new fix in every affected sub-package. The "merge order" risk (a meta PR merged early shipping mixed pins) is mitigated by documented procedure and a PR-template prompt, not tooling-enforced — see "Cross-package atomicity" above.
- **Per-package changelogs** make per-package release notes easy to find. Users tracking only `mssql-core` see only its history.
- **Conventional-Commit type discipline is enforced in CI** via commitlint. Type drift is a commitlint failure.
- **Pre-releases follow a phased alpha → beta → rc → stable lifecycle**, with the phase encoded in the version (`13.0.0-alpha.N`, `13.0.0-beta.N`, `13.0.0-rc.N`) and all phases published under the `next` npm dist-tag. Consumers install with `npm i mssql@next` for the latest pre-release of any phase, or by exact version for a specific one — see "Pre-release lifecycle" above.
- **Dependabot covers every workspace package automatically as new ones bootstrap.** No per-package config maintenance required — the `/packages/*` glob handles it.
- **The Dependabot config landing on `next-major` only takes effect once it also lands on `master`.** A one-time sync; once both branches carry the same config, workspace updates flow correctly. Documented above.
- **Switching `master` from semantic-release to release-please at v13.0 merge time is a planned migration**, not a surprise. The v12 changelog generated by semantic-release stays intact; release-please picks up from the v13.0 tag forward.
- **The release PR workflow has a small human step** (merging the PR) that semantic-release's "every push releases" model didn't. We treat that as a feature, not a bug — a maintainer eyeballs the proposed changelog before it hits npm.

## Alternatives considered

**`semantic-release` with `semantic-release-monorepo` plugin.** Rejected. Issue 1688 has been open since 2020 with no official path. The community plugins have correctness issues with cross-package commits and dep version updates, and the design forces a choice between lockstep and fragile per-package path-scoping. Building a long-lived release pipeline on third-party plugins that the upstream tool actively rejects is not a foundation we want.

**`@changesets/cli`** (used by pnpm, Astro, Remix, Apollo, Tailwind UI). Considered. Rejected because it adds per-PR developer friction: every PR that affects a package must include a `.changeset/*.md` file declaring which packages changed and at what bump level. For a small core team already disciplined about Conventional Commits, release-please's commit-driven model is lower friction with the same end result. If we ever want maintainer-curated release notes (rather than commit-driven), changesets is the better tool — but that is not the requirement.

**`release-it`** (used by `node-redis`). Rejected — fails the "full automation" requirement. `release-it` requires a maintainer to manually trigger a workflow with a pre-determined version, which is error-prone and surfaces version-bump decisions to humans that conventional-commit-driven tooling makes deterministically.

**Nx Release.** Rejected. We don't use Nx for the build, and adopting it just for releases is overkill ([ADR-0004](0004-monorepo-layout.md) already rejected Nx as a build tool).

**Strict version lockstep across all packages.** Rejected. Every sub-package republishing on every change makes version numbers dishonest (a `fix(pool-tarn)` should not bump `core` from 13.0.5 to 13.0.6 unchanged) and churns every consumer's lockfile for changes they have no relationship to. Independent per-package versioning, with the meta package's exact pins providing a single rolled-up version number for users who want one, gives both audiences what they need without the cross-package noise.

**`linked-versions` plugin to lockstep just `core` + `meta`.** Considered as a compromise — force the kernel and the umbrella to share a version number so users have a single "v13 line" to reason about. Rejected: with exact pins (above), the meta already bumps whenever core does, but its version stays its own — a meta-only change does not force a core republish, and a non-core sub-package bump can move the meta without touching core. `linked-versions` would reintroduce the dishonest-version-numbers problem on a smaller scale. Easy to add later via `linked-versions` config if version-number drift turns out to confuse consumers.

## References

- [release-please](https://github.com/googleapis/release-please) — main repo and docs.
- [release-please manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) — manifest-mode configuration reference.
- [release-please-action](https://github.com/googleapis/release-please-action) — the GitHub Action.
- [semantic-release issue #1688](https://github.com/semantic-release/semantic-release/issues/1688) — the still-open monorepo support thread.
- [Dependabot configuration reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- [ADR-0002: Same-repo pre-release branch strategy](0002-branch-strategy.md)
- [ADR-0004: Monorepo with npm workspaces](0004-monorepo-layout.md)
