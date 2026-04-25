# ADR-0002: Same-repo pre-release branch strategy

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

The rewrite ([ADR-0001](0001-scope-and-goals.md)) is long-running and will live alongside ongoing `v12.x` maintenance for multiple quarters. We need a development location that:

1. Does not publish a stable release by accident.
2. Preserves the `tediousjs/node-mssql` GitHub repo's linking, review history, issue trust, and contributor permissions.
3. Keeps the package name `mssql` on npm — users should not have to install a differently-named package.
4. Allows v12 bug fixes and dependabot PRs to continue landing on `master` without interfering.

## Decision

Work happens on a long-lived **pre-release branch** in the existing `tediousjs/node-mssql` repository. The specific branch name is a contributor-facing convention with no design weight; what matters is that pushes to it produce pre-release versions on a non-default npm dist-tag, never `latest`. Release tooling, the dist-tag name, and npm-publish gating are out of scope here and deferred to [ADR-0005](0005-release-and-ci.md).

`master` continues to publish `v12.x` on `latest` (the v12 release pipeline is unchanged during the rewrite).

When v13 reaches stable, the pre-release branch is **merged into `master`** (with `--no-ff`) and `13.0.0` is cut onto `latest`. The pre-release branch is then deleted. A merge commit (rather than a fast-forward) is deliberate: it preserves a clear, identifiable integration point in `master`'s first-parent history showing exactly where v13 landed, which matters for a long-running rewrite branch with hundreds of commits.

**v12 bug fixes do not land on the pre-release branch.** This is a clean-room rewrite; carrying v12 patches forward would re-import the implementation choices we are deliberately discarding. Where a v12 fix represents a *learning* — a bug class to avoid, an edge case the rewrite must cover — that learning is captured as a test case or an ADR note in the rewrite, not as a cherry-pick. The cost is a slightly heavier merge at v13.0 ship time; the benefit is that the rewrite history reflects only design choices the rewrite owns.

## Consequences

- No new repo, no new npm package name. The `mssql` package on npm receives v13 pre-releases via a non-default dist-tag.
- The existing `tediousjs/node-mssql` repo retains all its history, trust, and linking. GitHub issue references, contributor commits, and star history carry forward.
- v12 PRs (bug fixes, dependabot) land on `master` as today. They are **not** cherry-picked or merged into the pre-release branch. The two branches diverge cleanly until the v13.0 merge.
- The v13.0 merge into `master` is expected to be conflict-heavy (cross-cutting rewrite vs. ongoing v12 maintenance) and is treated as a planned integration step, not a routine merge. Resolving it is part of v13.0 release work.
- Contributors who want to try v13 check out the pre-release branch; nothing else changes.

## Alternatives considered

**A new repository (`tediousjs/mssql-next` or similar).** Rejected — loses trust, history, and the existing `mssql` npm name.

**Continuing on `master` behind feature flags.** Rejected because the kernel-level changes (tagged-template API, hexagonal driver port, ESM-only) cannot be feature-flagged, and any non-trivial rewrite work would still have to remain compatible with a published `latest` release at every commit.

## References

- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
- [ADR-0005: Release process, CI workflows, and dependency automation](0005-release-and-ci.md) — release tooling, dist-tag selection, and publish gating for the pre-release branch.
