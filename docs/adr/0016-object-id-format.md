# ADR-0016: Object ID format — `<prefix>_<process tag>_<counter>`

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

Debugging pooled, concurrent SQL workloads is hard without stable IDs on each object. "Connection 7" is meaningless across two processes; "a9b2f3c4-1d7e-4f8a-b1c2-d3e4f5a6b7c8" is unique but unreadable in a log. Developers skimming logs need IDs they can correlate at a glance.

v12 has no ID scheme. Diagnostics output refers to connections by their pool index, requests by nothing at all. When two processes share a database, log lines are unattributable.

Across the ecosystem, libraries like [pg-pool](https://github.com/brianc/node-postgres/tree/master/packages/pg-pool) use sequential integers (pool-local; not process-unique), and some use full UUIDs (globally unique but log-hostile). A hybrid — short process tag plus per-prefix counter — is cheap, human-skimmable, and collision-resistant across processes.

## Decision

Object IDs in `@tediousjs/mssql-core` follow this format:

```
<prefix>_<PROCESS_TAG>_<counter>

conn_a3f2b19c1d_1
req_a3f2b19c1d_47
tx_a3f2b19c1d_3
sp_a3f2b19c1d_12
pool_a3f2b19c1d_1
prep_a3f2b19c1d_5
```

**`PROCESS_TAG`**: 10 hex characters derived from a 5-byte buffer filled by `globalThis.crypto.getRandomValues()`, generated **once** at core module load. One tag per process. 40 bits of entropy gives a birthday-collision 50% threshold at ~1M concurrent processes — well beyond any realistic deployment scale — while keeping the tag log-friendly. Deployments operating well past that scale (where the user is already thinking hard about cross-process correlation anyway) override the generator entirely; see "Override" below.

Using WebCrypto's `getRandomValues` rather than Node's `crypto.randomBytes` is a deliberate portability choice: `globalThis.crypto` is present and behaviourally equivalent on Node 18+, Deno, Bun, Cloudflare Workers, and Vercel Edge — the same runtime surface this library supports ([ADR-0003](0003-runtime-targets.md)). Using the Node-only API here would force edge consumers to shim it. The randomness quality and performance are indistinguishable at this call site.

**Counter**: monotonically increasing integer, **per prefix**, scoped to the process. `conn_` and `req_` have independent counters. Counter starts at 1 on module load.

**Prefix**: short, typed, stable. The full set:

| Prefix | Object |
|---|---|
| `conn` | driver-level `Connection` |
| `pool` | pool adapter instance |
| `req` | a `Query` execution (request on the wire) |
| `tx` | transaction handle |
| `sp` | savepoint handle |
| `prep` | prepared statement handle |
| `bulk` | bulk load operation |

IDs appear in:

- `diagnostics_channel` context on every event ([ADR-0014](0014-diagnostics.md)).
- `MssqlError.connectionId` / `.queryId` / etc. on every thrown error.
- `toString()` on every object (`ConnectionPool#<pool_a3f2b19c1d_1>`).

### Override

`createClient({ idGenerator })` accepts a custom generator. The generator receives both the prefix and the per-prefix counter so users who want to keep the sequential-counter affordance do not have to re-implement it themselves:

```ts
type IdGenerator = (prefix: string, counter: number) => string

createClient({
  driver: tedious(),
  idGenerator: (prefix, counter) => `${POD_NAME}-${prefix}-${counter}`,
})

// Or ignore the counter entirely if you want pure UUIDs:
createClient({
  idGenerator: (prefix) => `${prefix}-${crypto.randomUUID()}`,
})
```

When overridden, the default generator is not used at all — the user's function is authoritative for every ID in the client. Passing the counter through is free (core already maintains it to produce the default IDs) and removes the most common reason users would need to hand-roll an atomic counter of their own. Users who do not want ordering (pure-random, UUID-based, pod-scoped) simply ignore the second argument.

This covers Kubernetes users who want pod-scoped IDs, anyone wanting UUIDs for easy grep-by-pasting, or test scenarios that want deterministic IDs.

## Consequences

- Log lines become correlatable across objects in the same process (`conn_a3f2b19c1d_1` appears in the connect event, the query events that used it, and the release event) and distinguishable across processes (different `PROCESS_TAG`).
- IDs are short enough to fit in a log prefix without wrapping (~17 characters vs ~36 for a UUID).
- The counter is not durable across restarts — `req_a3f2b19c1d_47` from yesterday and `req_a3f2b19c1d_47` from today are different requests. This is fine: `PROCESS_TAG` changes at restart, so full IDs never actually repeat across processes-over-time.
- `PROCESS_TAG` is not cryptographic — two processes starting at the same time could theoretically collide on tag values. With 40 bits of randomness, collision probability stays under one-in-a-million for deployments under ~1,500 concurrent processes and well under one-in-a-thousand at 10k. Operators running deployments where collisions matter at far higher scale (tens or hundreds of thousands of processes against the same SQL Server fleet) will already be making per-pod-or-per-process correlation decisions on their own — they should provide a custom `idGenerator` (e.g. `randomUUID()`-based, or pod-name-prefixed) rather than expect the default tag to scale to that regime.
- The counter is an atomic integer per prefix, shared across all clients in the same process. A single process running multiple `createClient` instances still gets globally monotonic `conn_` / `req_` / etc. counters. This is deliberate — makes cross-client correlation easier.
- Custom `idGenerator` fully replaces the default, so users who override lose the prefix convention unless they maintain it themselves. The prefix and counter arguments to the generator function make this ergonomic — the common "pod-scoped but still sequential" case is a one-liner.
- `globalThis.crypto.getRandomValues()` works uniformly across Node, Deno, Bun, and edge runtimes without a runtime shim; consumers deploying to Workers / Vercel Edge do not have to polyfill `node:crypto`.

## Alternatives considered

**Full UUIDs per object.** Rejected — unreadable in a log. Easy to diff two UUIDs with tooling but hard to eyeball whether two log lines refer to the same connection.

**Pure sequential integers (pool-local).** Rejected — loses process attribution. Two processes' logs interleaved would have `conn_1` in both.

**Pure random (e.g. `randomUUID().slice(0, 8)`).** Considered. Rejected — no ordering information. A reader skimming logs cannot tell that `conn_a3f2` came before `conn_b7c1`. The counter preserves within-process order.

**Separate counter per `Client` instance.** Considered. Rejected because most users have one client, and the rare multi-client user is better served by globally monotonic IDs for correlation than by per-client locality.

**Human-readable prefixes like `connection_`, `request_`.** Rejected for brevity. `conn_` vs `connection_` saves 6 characters per log line; at SQL-heavy workloads this adds up and readability is not materially worse.

**Use `performance.now()` or `Date.now()` as the tag.** Rejected — time-based IDs encode ordering but add no entropy, and two processes starting at the same millisecond would collide.

## References

- [ADR-0003: Runtime targets](0003-runtime-targets.md) — the Node/Deno/Bun/edge surface that motivates using WebCrypto here.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — the primary consumer of these IDs.
- [WebCrypto `getRandomValues`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)
