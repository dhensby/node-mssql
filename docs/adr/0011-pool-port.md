# ADR-0011: Pool port — pooling as an optional, swappable adapter

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12 hardcodes [tarn](https://github.com/vincit/tarn.js) as the connection pool. Users who want a different pooling strategy — or none at all — have no clean way to opt out. This conflicts with two goals of the rewrite:

1. **Hexagonal architecture** — drivers are already a port ([ADR-0010](0010-driver-port.md)). Pooling is a separate concern with a separate lifecycle and has no business being fused to either the driver or the kernel.
2. **Edge and serverless deployments** — a lambda, a cloudflare worker, or a short-lived process invoked per request has no use for a pool. The right behaviour is "open a connection, run the query, close the connection." Forcing a pool onto that deployment shape is waste and, in some environments, a correctness problem (idle-connection eviction, stale-TCP-on-resume, per-invocation quota limits).

The v13 unified `Queryable` ([ADR-0006](0006-queryable-api.md)) already talks to connections through an `acquire` / `release` shape — every query path boils down to "get a connection, run something, give it back." That same contract is the pool's public surface. Making pooling a port is straightforward: define the acquire/release shape, provide a no-pool default, and ship tarn as an optional adapter.

## Decision

Pooling is a **port** in `@tediousjs/mssql-core`, not a fused dependency. The port is minimal:

```ts
interface Pool {
  readonly state: 'open' | 'draining' | 'destroyed'
  acquire(signal?: AbortSignal): Promise<PooledConnection>
  drain(): Promise<void>        // stop accepting new acquisitions, wait for in-flight to finish
  destroy(): Promise<void>      // force-close all connections now
}

interface PooledConnection extends AsyncDisposable {
  readonly connection: Connection   // the driver-port Connection from ADR-0010
  release(): Promise<void>          // return to pool; implicit via [Symbol.asyncDispose]
  destroy(): Promise<void>          // mark as broken; pool replaces rather than reuses
}
```

`state` is observable by the client as a property on the pool. The client's dispatcher reads it to gate entry points as a fast path; if the pool's state changes mid-acquire, the adapter throws `PoolClosedError` at the port boundary and the client wraps it as `ClientClosedError` for consumers (see [ADR-0017](0017-error-taxonomy.md)). Pool and client each own their own error vocabulary; there is no leakage across the domain boundary.

The `pool` option to `createClient` is a **factory**, not a constructed pool, so core can pass the adapter its context (driver, hooks, id generator) at the same moment it hands the adapter to the client:

```ts
type PoolFactory = (ctx: PoolContext) => Pool

interface PoolContext {
  driver: Driver
  hooks?: { onAcquire?(sql: Queryable): Promise<void>; onRelease?(sql: Queryable): Promise<void> }
  // plus core-provided utilities: idGenerator, diagnostics channel accessors, ...
}
```

- **`pool` omitted** — core uses a built-in `SingleConnectionPool`: one connection, opened lazily on first acquire, held for the life of the client, closed on `drain()` / `destroy()`. `Connection.reset()` runs on each release so per-acquire state hygiene matches what users get from tarn. Zero dependencies; PHP-one-connection-per-process shape. Optimal for edge/serverless/short-lived processes that do one or a few queries per invocation.
- **`pool: tarn(opts)`** — use the `@tediousjs/mssql-tarn` adapter. Tarn's min/max/idle/acquire semantics. This is what the meta `mssql` package wires up for zero-config users, keeping the `npm i mssql` experience unchanged.
- **`pool: myCustomPool`** — any factory returning an object that implements the port. Third parties can ship their own adapters (generic-pool, undici-style LIFO, deno's pool, whatever) without forking core.

The `Queryable` API is unchanged whether the pool is tarn, single-connection, or custom. `sql\`...\`` acquires a connection from the pool, runs the query, releases when the terminal completes. `sql.acquire()` returns a `ReservedConn` that holds a single connection for its disposable lifetime. `sql.transaction()` acquires at `BEGIN`, releases after `COMMIT`/`ROLLBACK`. From the user's perspective, swapping pool adapters is a configuration change; the code is identical.

Core ships exactly one built-in pool implementation (`SingleConnectionPool`) and the port definition. Tarn lives in `@tediousjs/mssql-tarn`, peer-depending on core. This mirrors how drivers are structured: small core with minimal defaults, optional packages for batteries.

### Cancellation contract: signal-driven, adapters do not own timeouts

`pool.acquire(signal)` respects the inbound `AbortSignal` as the **single cancellation mechanism**. Adapters do not maintain their own acquire timeouts, do not layer a `defaultTimeout`-derived timer of their own, and do not invent adapter-specific cancellation knobs. The client constructs the signal (from the caller, from `defaultTimeout`, or both composed) and the adapter honours it. This keeps cancellation unified across the library: one signal controls acquire + dispatch + first-byte ([ADR-0013](0013-cancellation-and-timeouts.md)), and `mssql:query:aborted` ([ADR-0014](0014-diagnostics.md)) publishes uniformly whether the abort landed in the pool phase or later.

When the signal fires, the adapter propagates the abort into whatever pending work it has (tarn's internal aborter, a `fetch`-style race, whatever the library provides) and rejects the acquire. The rejection is translated to `AbortError` or `TimeoutError` — derived from `signal.reason` — at the port boundary ([ADR-0017](0017-error-taxonomy.md)).

**Tarn is a grandfathered exception.** Tarn's `acquireTimeoutMillis` is not optional — the library insists on its own timeout regardless of whether a signal is also provided. The `@tediousjs/mssql-tarn` adapter handles this by:

1. Forwarding the inbound `signal` into tarn's own aborter so a consumer abort still wins the race and surfaces as `AbortError` / `TimeoutError`.
2. Translating tarn's *own* `acquireTimeoutMillis` firing (when the consumer signal has *not* fired) to `PoolAcquireTimeoutError` — a pool-contention-specific class distinct from the signal-driven abort path.

This two-class outcome is deliberate: consumer-initiated cancellation and pool-internal contention are genuinely different failure modes. A user whose signal timed out probably wants to retry or surface latency; a user who hit `acquireTimeoutMillis` needs to inspect pool saturation. Keeping the errors separate avoids sending people on the wrong debugging mission. Adapters without an internal timeout concept never emit `PoolAcquireTimeoutError`; the class exists for tarn-style libraries only.

### Lifecycle hooks: client-defined shape, pool-run, portable across adapters

A pooled connection that idles back into the pool may carry session state that the next acquirer would not expect: a temp table the previous holder created, a `SET LANGUAGE` the previous holder changed, a database context the previous holder switched to via `USE`, a non-default transaction isolation level. TDS's `sp_reset_connection` resets *most* of this automatically (pool adapters call `Connection.reset()` on release — [ADR-0010](0010-driver-port.md)), but not everything — notably, `sp_reset_connection` preserves the last `USE <database>` selection and does not run anything application-specific.

Core defines two client-level lifecycle hooks — `onAcquire` and `onRelease` — whose **shape is core-owned** but whose **execution is the pool adapter's responsibility**. The hook signature is part of the pool port contract; every adapter runs the hooks at the appropriate lifecycle moment. The user writes hooks once, pool adapters swap in and out transparently:

```ts
createClient({
  pool: tarn(opts),   // or singleConn(opts), or any third-party adapter
  hooks: {
    onAcquire: async (sql) => {
      await sql.ping()                                    // validate connection is alive
      await sql`USE ${sql.ident('app_main')}`.run()       // force default database
      await sql`SET LANGUAGE us_english`.run()            // force default language
    },
    onRelease: async (sql) => {
      // application-scoped cleanup — drop temp tables under a known prefix, etc.
    },
  },
})
```

The client hands the hooks to the pool factory via `PoolContext` at construction. The adapter runs them inside its own acquire / release paths. **The kernel never sees an unhealthy connection or a failed hook.** A connection handed back from `pool.acquire()` has already been validated *and* had `onAcquire` successfully applied; if either failed, the pool retired that connection and tried again internally. On release, the kernel hands the connection back to the pool, which runs `onRelease`, then calls `Connection.reset()`, then (for tarn) requeues or (for `SingleConnectionPool`) marks idle-available.

This threads both needles the previous design tried to balance:

- **Hook shape is portable.** Because core defines the signature (with `sql` as a `Queryable` bound to a driver-port `Connection`), swapping `tarn()` for `singleConn()` or a third-party adapter requires no hook rewiring. The same hook body runs on every adapter.
- **Unhealthy connections stay inside the pool.** The pool's job is "give me a healthy, hook-applied connection or fail honestly"; the kernel doesn't deal with validate-fail retries, doesn't re-enter acquire on hook failure, doesn't emit hook-retry telemetry. If the pool can't produce a healthy connection, it throws — the kernel surfaces that as-is.
- **Adapters are the natural owner of the full acquire lifecycle.** Tarn already has `propagateCreateError` + internal validators + its own retry loop. Running `onAcquire` inside that loop is a clean extension: it sits alongside the adapter's native validate step and shares the same "if this fails, destroy and try again" semantics. Third-party adapters implement the same contract against a core-defined hook shape — they do not invent their own hook surface.

Semantics:

- `onAcquire` runs inside the pool's acquire path, after the adapter's own validation (e.g. a driver-level health check), before the connection is returned. If it throws, the adapter destroys the connection and retries — either pulling another cached connection or creating a fresh one, under whatever retry policy the adapter documents. From the consumer's perspective this is still a single logical acquire; retries are internal, bounded by `defaultTimeout` / signal. If the adapter ultimately cannot produce a healthy connection (create-failure — see below), it throws a `ConnectionError` and the consumer sees it immediately. Intended for validation, state normalisation, and user-specific settings.
- `onRelease` runs inside the pool's release path, before the adapter's own internal cleanup (`Connection.reset()` and requeue-or-close). If it throws, the adapter destroys the connection rather than returning it to the idle set. Intended for application-scoped cleanup that `sp_reset_connection` does not cover.
- Both emit `mssql:connection:reset` from the adapter with `stage: 'on-acquire' | 'on-release'` and `durationMs` (see [ADR-0014](0014-diagnostics.md)). The `stage: 'driver'` event for `Connection.reset()` itself is emitted by the driver.

Pool adapters distinguish **validate-failure** (a cached connection turned out to be dead, or `onAcquire` threw — recover silently by swapping in another cached connection or creating a fresh one) from **create-failure** (a fresh connection could not be established — surface immediately as `ConnectionError` rather than burning the caller's timeout budget in a retry loop). This is a port-level requirement on adapter authors; tarn already works this way, and [ADR-0017](0017-error-taxonomy.md) specifies the contract in full.

**`SingleConnectionPool` implements the same hook contract.** On the first `acquire()`, the pool opens its one connection and runs `onAcquire`; if either step fails, it closes and tries once more (with the same validate-vs-create split — a fresh-open failure is terminal). On `release()`, it runs `onRelease`, then `Connection.reset()`, then marks the connection idle-available for the next acquire. Because the same hook shape runs, a configuration that works under tarn continues to work under `SingleConnectionPool` without changes.

### Connection liveness: `ping()` on the driver port

For the "is this connection actually alive?" check that `onAcquire` most often needs, core adds `ping()` to the `Connection` driver port ([ADR-0010](0010-driver-port.md)):

```ts
interface Connection {
  // ... existing methods
  ping(): Promise<void>    // resolves on success; rejects if the connection is dead
}
```

Drivers implement `ping()` however their protocol allows cheaply. `tedious` sends a minimal TDS batch (equivalent to `SELECT 1`, or a SMP keepalive if the channel supports it); `msnodesqlv8` invokes the ODBC connection-attribute check. The contract is "if this resolves, the connection is usable for a subsequent `execute()`; if it rejects, destroy this connection." Drivers may use a real round-trip or a protocol-level ping where supported — the choice is driver-internal.

The `Queryable` passed into `onAcquire` / `onRelease` exposes this as `sql.ping()` for ergonomic hook bodies. Users can of course issue `sql\`SELECT 1\`.run()` directly; `ping()` is a documented shortcut and also the cheapest possible check for drivers that implement it as a non-query TDS packet.

This addresses [tediousjs/node-mssql#1834](https://github.com/tediousjs/node-mssql/issues/1834) — "provide a way to check if a pooled connection is alive without doing a full query" — by adding the primitive at the driver port and making it available where pooled users actually consume it.

## Consequences

- `npm i mssql` still gets tarn by default (the meta package depends on `@tediousjs/mssql-tarn`). Zero-config users notice no change.
- `npm i @tediousjs/mssql-core @tediousjs/mssql-tedious` — no tarn, no pool, single-shot connections. Valid and documented for edge/serverless.
- `npm i @tediousjs/mssql-core @tediousjs/mssql-tedious @tediousjs/mssql-tarn` — power-user pool-on path.
- Third-party pool packages are a supported extension point. The shape they implement is the same shape first-party `@tediousjs/mssql-tarn` implements — no internal/external asymmetry.
- `SingleConnectionPool` serialises concurrent acquires on one underlying connection. For hot-path workloads with real concurrency, tarn's min/max is the correct choice and the meta `mssql` package still defaults to it. The one-connection-per-client shape is deliberate for the edge/serverless deployments that target it: most invocations do one or a few queries and would otherwise re-establish a connection per query.
- Transactions, savepoints, prepared statements, and `sql.acquire()` all continue to work with a single-connection pool because they only use `acquire` / `release`. The underlying connection is the same one every time, so session-scoped state inside a `sql.acquire()` block behaves identically to any other adapter.
- Diagnostics (`mssql:pool:acquire`, `mssql:pool:release`, etc. — see [ADR-0014: Diagnostics](0014-diagnostics.md)) emit the same events regardless of which pool adapter is in use. Users get consistent observability whether they are on tarn, custom, or single-shot.
- Drivers and pools are orthogonal. Any driver works with any pool. The core's responsibility is to keep them that way — no pool adapter should need to know which driver is in use, and vice versa.

## Alternatives considered

**Keep tarn as a core dependency; expose its options.** Rejected — this is what v12 does. It works but forecloses on no-pool deployments and locks every user into tarn's specific semantics (FIFO vs LIFO, idle handling, etc.) forever.

**Ship multiple pools in core and let users pick by config string.** Rejected — fat core, and third parties still cannot plug in their own. The port approach gets the same ergonomics (`pool: tarn()` vs `pool: singleShot()`) with none of the fat.

**Make no-pool the default in the meta `mssql` package too.** Considered — it would make "install mssql, it just works" an even thinner package. Rejected because the dominant deployment shape is still long-running services where pooling is correct, and changing the default would silently regress performance for users migrating from v12 who are unaware. The meta package is opinionated on their behalf; users who want no-pool opt in explicitly by reaching for core directly.

**No built-in pool; just make `pool` required.** Rejected — the whole point is to let edge/serverless users do less work, not more. Requiring them to write a pool adapter or pull in a dependency for "hold one connection" is worse than the built-in default.

**Keep the original `SingleShotPool` (open-per-query, close-on-release) semantics.** Considered — truly zero state, no idle connection between calls. Rejected because edge/serverless invocations that make more than one query end up paying the connect cost per query, which is the main overhead users are trying to avoid. Holding one connection for the life of the client matches the PHP-style "one connection per process" pattern that maps naturally to an edge invocation's lifetime, and `Connection.reset()` on each release keeps per-acquire state hygiene intact.

**Fuse pool into the driver port.** Rejected — they have genuinely different concerns (driver = wire protocol + auth; pool = lifecycle + concurrency). Fusing them means every new driver must also ship pool semantics, and every new pool must know about each driver. The Cartesian product goes bad fast.

**Push lifecycle hooks into each pool adapter's config (tarn's `onRelease`, generic-pool's factory methods, etc.) with each adapter inventing its own shape.** Rejected because every adapter re-inventing its own hook shape forces the user to rewrite hook wiring when swapping adapters, even though the hook *body* is portable. The chosen split — core owns the *shape*, adapters own the *execution* — captures the portability benefit without paying the cost.

**Have the kernel wrap `pool.acquire()` / `pool.release()` with the hooks, leaving adapters hook-agnostic.** Previously drafted. Rejected because it forces the kernel into the unhealthy-connection-handling business: if `onAcquire` fails (ping fails, `USE <db>` fails), the kernel has to destroy the connection and re-enter `pool.acquire()`, either with or without a retry cap. Either choice is awkward — a cap is arbitrary, and uncapped loops burn timeout budgets on pool-internal problems the consumer cannot do anything about. Moving hooks into the adapter makes "return a healthy hook-applied connection or fail honestly" a single contract owned by one layer. The kernel receives only good connections and surfaces only honest errors.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md)
- [ADR-0010: Driver port (hexagonal architecture)](0010-driver-port.md)
- [ADR-0014: Diagnostics](0014-diagnostics.md)
- [tarn](https://github.com/vincit/tarn.js) — the pool that first-party `@tediousjs/mssql-tarn` adapts.
- [tediousjs/node-mssql#1517](https://github.com/tediousjs/node-mssql/issues/1517) — acquire-a-single-connection request; the pool port makes single-shot deployments trivial alongside it.
