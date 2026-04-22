# ADR-0002: Same-repo `next-major` branch strategy

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

The rewrite ([ADR-0001](0001-scope-and-goals.md)) is long-running and will live alongside ongoing `v12.x` maintenance for multiple quarters. We need a development location that:

1. Does not publish a stable release by accident.
2. Preserves the `tediousjs/node-mssql` GitHub repo's linking, review history, issue trust, and contributor permissions.
3. Keeps the package name `mssql` on npm — users should not have to install a differently-named package.
4. Allows v12 bug fixes and dependabot PRs to continue landing on `master` without interfering.

## Decision

Work happens on a long-lived branch named **`next-major`** in the existing `tediousjs/node-mssql` repository.

The name `next-major` was originally chosen because it is the default pre-release branch name recognised by `semantic-release`. The release tooling has since been switched to `release-please` ([ADR-0005](0005-release-and-ci.md)), but the name still works cleanly: release-please's `prerelease-type: "next-major"` config produces the same `13.0.0-next-major.N` shape under the `next-major` npm dist-tag. Users never receive a pre-release on `latest` by mistake; they opt in with `npm i mssql@next-major`.

**The release-please workflow runs on `next-major` from day one** ([ADR-0005](0005-release-and-ci.md)). Every push to the branch opens or updates a per-package release PR with the proposed version bump and changelog entries. This is deliberate: it lets the team see what a release would look like at any point during the rewrite, and surfaces commit-message or scope-policy mistakes early.

**The npm-publish step is gated** behind a workflow conditional and does not fire until v13 is ready for early adopters. This prevents publishing `13.0.0-next-major.N` versions that nobody can usefully consume during the rewrite period. When the library is ready for early adopters to try, the conditional is lifted (a single boolean flip) and merging a release PR will publish to npm under the `next-major` dist-tag.

`master` continues to publish `v12.x` on `latest` via `semantic-release` (the v12 release pipeline is unchanged during the rewrite).

When v13 reaches stable, `next-major` is **merged into `master`** (with `--no-ff`) and the cutover happens: `master`'s release pipeline is switched from `semantic-release` to `release-please` ([ADR-0005](0005-release-and-ci.md)) and `13.0.0` is cut onto `latest`. The `next-major` branch is then deleted. A merge commit (rather than a fast-forward) is deliberate: it preserves a clear, identifiable integration point in `master`'s first-parent history showing exactly where v13 landed, which matters for a long-running rewrite branch with hundreds of commits.

**v12 bug fixes do not land in `next-major`.** This is a clean-room rewrite; carrying v12 patches forward would re-import the implementation choices we are deliberately discarding. Where a v12 fix represents a *learning* — a bug class to avoid, an edge case the rewrite must cover — that learning is captured as a test case or an ADR note in the rewrite, not as a cherry-pick. The cost is a slightly heavier merge at v13.0 ship time; the benefit is that `next-major` history reflects only design choices the rewrite owns.

## Consequences

- No new repo, no new npm package name. The `mssql` package on npm receives v13 pre-releases cleanly via the `next-major` dist-tag.
- The existing `tediousjs/node-mssql` repo retains all its history, trust, and linking. GitHub issue references, contributor commits, and star history carry forward.
- v12 PRs (bug fixes, dependabot) land on `master` as today. They are **not** cherry-picked or merged into `next-major`. The two branches diverge cleanly until the v13.0 merge.
- The v13.0 merge into `master` is expected to be conflict-heavy (cross-cutting rewrite vs. ongoing v12 maintenance) and is treated as a planned integration step, not a routine merge. Resolving it is part of v13.0 release work.
- Contributors who want to try v13 check out `next-major`; nothing else changes.

## Alternatives considered

**A new repository (`tediousjs/mssql-next` or similar).** Rejected — loses trust, history, and the existing `mssql` npm name.

**A new branch with ad-hoc pre-release config.** Rejected at the time on the rationale that `next-major` matched `semantic-release` defaults out of the box. After the switch to `release-please` ([ADR-0005](0005-release-and-ci.md)) the branch name is no longer load-bearing for tooling defaults, but the name continues to communicate intent clearly to contributors and to npm consumers via the dist-tag, so we kept it.

**A branch named `v13` or `rewrite`.** Rejected — these names do not communicate the *next major* nature of the work as clearly to contributors landing on the repo, and `next-major` is conventional across the npm ecosystem for pre-release branches.

## References

- [release-please prerelease configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
- [ADR-0005: Release process, CI workflows, and dependency automation](0005-release-and-ci.md)
