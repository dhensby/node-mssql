# ADR-0003: Runtime targets — ESM, TypeScript 6+, Node 20+

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 targets Node 18+, ships CommonJS, and is authored in JavaScript with JSDoc. None of these choices fit a 2026 greenfield library:

- TypeScript-native source is necessary for the strict compile-time guarantees we want on parameter typing, prepared-statement generics, and stored-procedure output types.
- `AsyncDisposable` (explicit resource management, `await using`) is central to the v13 API ([ADR-0006](0006-queryable-api.md), [ADR-0008](0008-query-lifecycle-and-disposal.md)).
- `AbortSignal.any()` is used extensively for cancellation and timeout composition.
- `diagnostics_channel.tracingChannel` is our observability spine.
- Publishing dual CommonJS + ESM has a high ongoing cost (build pipeline, subtle interop bugs, doubled instance identity) and a declining benefit.

The principle we are operating under: **do not exclude older Node versions without a concrete benefit.** A Node floor is expensive for adopters and cheap for us to push upward later. We set the floor at the oldest version that genuinely supports the API surface we need, not at the most recent LTS by reflex.

## Decision

- **ESM only.** `"type": "module"` in every package, `.js` extensions in import paths. CommonJS consumers use dynamic `import()`.
- **TypeScript 6+ as the source language.** Strict mode enabled; no implicit `any`; `exactOptionalPropertyTypes`; `noUncheckedIndexedAccess`.
- **Node 20.3+ required** at launch. `engines.node: ">=20.3.0"`. Rationale for the specific floor:
  - `AbortSignal.any()` landed in Node 20.3.
  - `AbortSignal.timeout()` (Node 17.3+), `diagnostics_channel.tracingChannel` (Node 19.9+/18.19+), and the ES2023 array helpers all pre-date Node 20.
  - Native `await using` landed in Node 22.12, but TypeScript 5.2+ emits runtime helpers (`__addDisposableResource`, `__disposeResources`) that use `Symbol.asyncDispose` when present and `Symbol.for("Symbol.asyncDispose")` otherwise. The downleveled code interoperates cleanly with Node 22's native disposable handling.
- **Target output:** ES2022 (so `using` and `await using` are downleveled to the TS helpers; Node 22 users still get native `Symbol.asyncDispose` via the helper's native-preference). Module resolution `bundler`.
- **Test matrix at launch:** Node 20, 22, 24. If and when Node 20 becomes too expensive to support — measured by real maintenance burden, not age — we bump the floor in the next major release. **Node floor bumps are major-only**: never in a minor, never in a patch.
- Distribution: compiled `.js` + `.d.ts` from TypeScript. No bundler, no transpiler chain, no dual package hazards.

## Consequences

- Consumers on Node 20.3+ can use v13 at launch. This broadens the addressable install base substantially compared to a Node 22 floor.
- Consumers on Node 18 cannot use v13 and must stay on v12 until they upgrade their runtime. Node 18 reached end-of-life in March 2025, so the affected population should already be planning a runtime upgrade independent of v13.
- Consumers using CommonJS must use dynamic `import()` or migrate to ESM. This is a real cost and we accept it — the alternative is permanent dual-publish tax.
- The test matrix is one entry larger than a Node-22-only policy would be. This is a small ongoing CI cost for a meaningful adoption benefit.
- The TS `await using` downlevel adds a handful of bytes of helper code per file that uses it. Negligible.
- We explicitly commit to not arbitrarily raising the Node floor. Any future bump must be justified by a concrete new capability we want to use, documented in an ADR, and shipped in a **major release** — never a minor, never a patch. A floor bump is a breaking change for consumers still on the dropped Node version (their `npm install` either refuses outright on `engines.node` mismatch or installs without the runtime guarantees the code assumes), so semver treats it as a breaking change.

## Alternatives considered

**Node 22 floor.** Considered because Node 22 is the most recent LTS and offers native `await using`. Rejected: the TS downlevel path is mature, well-tested, and interoperates correctly with Node 22's native support. Excluding Node 20 at launch would remove a large user segment for no durable technical benefit.

**Node 18 floor.** Considered for maximum reach. Rejected: `AbortSignal.any()` is used throughout cancellation composition and requires Node 20.3+. Polyfilling it would add a dependency and a subtle correctness risk we do not want.

**Dual CJS + ESM publishing.** Considered because some consumers remain on CJS. Rejected: the dual-publish pattern has well-known hazards (double package instances, incompatible `instanceof` checks across the boundary), maintenance cost is permanent, and the value is temporary.

**JavaScript + JSDoc (like v12).** Rejected. The compile-time guarantees we want on parameter types ([ADR-0006](0006-queryable-api.md)) are not expressible in JSDoc without pain.

**Bump the Node floor in minor releases.** Some libraries treat dropping an EOL Node version as additive (the new minimum is always available on supported runtimes) and ship the bump in a minor. Rejected for this library: a floor bump is a breaking change for users still pinned to the dropped version, full stop. `engines.node` enforcement either fails their `npm install` outright (with `engine-strict=true`, common in CI) or — worse — installs silently and surfaces as runtime errors when missing APIs are called. Either failure mode is exactly what semver-major exists to signal. Shipping floor bumps as majors is more expensive for us (we publish majors less often) and that is the point: it disciplines the decision and gives consumers a predictable upgrade path. There is no use case for a "surprise" floor bump in a minor that benefits users.

## References

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [TC39 Explicit Resource Management proposal](https://github.com/tc39/proposal-explicit-resource-management)
- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
- [ADR-0006: Unified queryable API](0006-queryable-api.md)
