# ADR-0018: Client lifecycle — `createClient`, `connect`, `close`, `destroy`

- **Status:** Accepted
- **Date:** 2026-05-01
- **Deciders:** @dhensby

## Context

The `Client` is the user-facing object returned by `createClient(opts)`. It owns a pool ([ADR-0011](0011-pool-port.md)) and orchestrates queryable scopes ([ADR-0006](0006-queryable-api.md)). Earlier ADRs define the queryable surface and the pool port but not the client's own lifecycle — when does it open, when does it close, what counts as "in flight" during close, what errors surface at each transition.

Three concerns motivate spec'ing this explicitly:

1. **Startup error surfacing.** Connection failures during pool populate must reach the user's bootstrap code, not become uncaught promise rejections.
2. **Graceful shutdown.** `close()` should let in-flight work complete; `destroy()` should force teardown for hard shutdowns.
3. **Pre-connect / post-close clarity.** Queries fired before connect or after close need clear, fail-fast error semantics.

This ADR records the lifecycle decisions. Error class identities live in [ADR-0017](0017-error-taxonomy.md); lifecycle semantics — including which error class surfaces at each transition — are here.

## Decision

### `createClient(opts)` is synchronous

`createClient(opts)` constructs a client object and returns it immediately. No connection has been made; the pool factory ([ADR-0011](0011-pool-port.md)) has been called and the pool is in `'open'` state with no connections yet (lazy adapters) or eager populate just kicked off in the background. The client itself is **`pending`** — config is recorded, but nothing has touched the wire.

### `client.connect()` is required and async

`await client.connect()` is the awaited entry point that triggers the pool's eager populate / first-connection validation. **It is required before queries can fire.**

Why required: without an awaited entry point, the pool would have to populate in the background, and errors during populate (auth failure, network unreachable, misconfiguration) would surface as **uncaught promise rejections** that crash the process. With `client.connect()` mandatory, those errors propagate via the returned Promise — caught at startup, in the user's bootstrap code, where they can be reported and the process can exit cleanly. This matches v12's `connect()` model and the wider ecosystem (.NET, JDBC, pg) where explicit connection establishment is the norm.

```ts
const client = createClient({ /* … */ })
try {
  await client.connect()
} catch (e) {
  // ConnectionError / CredentialError — config is bad
  process.exit(1)
}
// client is now `'open'` and ready for queries
```

Errors during `connect()` use the standard taxonomy ([ADR-0017](0017-error-taxonomy.md)): `ConnectionError` for network / auth / handshake, `CredentialError` (subclass) for credential-specific failures. The `phase` field on any abort during connect is `'pool-acquire'` or `'connect'` depending on what was running.

**Retrying after a failed connect — construct a new client.** A rejected `connect()` transitions the client to `'destroyed'`, which is terminal. To retry after a transient startup failure (server warming up, DNS propagating, network blip), or to reconnect after an explicit `close()`/`destroy()`, the user constructs a fresh client with the same config and calls `connect()` on it. The configuration is the value already passed to the original `createClient`; in practice retry is one extra line at the call site, and "this client is broken, give up on it" becomes an explicit, observable action rather than a state-machine transition. A retry-with-backoff loop wraps `createClient` + `connect`, not `connect` alone:

```ts
async function connectWithRetry(config, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const client = createClient(config)
    try {
      await client.connect()
      return client
    } catch (e) {
      if (i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, 1000 * 2 ** i))   // user-defined backoff
    }
  }
}
```

**Idempotency:** repeated `connect()` calls during a single in-flight attempt return the same Promise as the first call. Calling `connect()` from `'open'` is a no-op (returns a resolved Promise, matching the convention used by `close()` and `destroy()`). Calling `connect()` from `'draining'` or `'destroyed'` throws `ClientClosedError` — these states are terminal-or-shutting-down and cannot be reconnected; users wanting to reconnect construct a new client.

### Queries before `connect()` throw `ClientNotConnectedError`

Queries fired against a `pending` client reject with `ClientNotConnectedError` — fail-fast, matching v12. The rejection arrives via the standard Promise path: terminal methods (`.all()`, `.run()`, `.result()`, etc.) check `client.state` on entry to their async body and throw `ClientNotConnectedError`, which surfaces as a Promise rejection at the consumer's `await` site. `for await (const row of q)` against a `pending` client sees the rejection on the iterator's first `next()` call and propagates it through the loop. Sync-throwing for this one error class would force consumers to wrap both the terminal call *and* the `await` in their error-handling, and would bypass async-error instrumentation hooks (OTEL, structured logging) that subscribe on the Promise-rejection path. The library does not queue queries in pre-connected state because that would create ambiguity ("when will this query actually run?") and hide config errors that should surface at startup via `connect()`.

### `client.close()` — graceful drain

`client.close()` calls `pool.drain()` ([ADR-0011](0011-pool-port.md)). Semantics:

1. State transitions to `'draining'`.
2. **New acquires** are rejected with `PoolClosedError({ state: 'draining' })` → wrapped to `ClientClosedError({ state: 'draining' })` by the dispatcher.
3. **In-flight acquires** (already past `pool.acquire()` entry — either holding a connection or queued) **continue to be served** (port contract — see [ADR-0011](0011-pool-port.md), "Drain serves queued acquires"). Released connections go back to the pool to fulfil any waiting acquires before any are closed.
4. When all acquires complete and all connections are released, the pool transitions to `'destroyed'` and closes them.
5. `client.close()`'s returned Promise resolves once the pool is fully destroyed.

This is the standard graceful-shutdown pattern. Most apps call it on SIGTERM / SIGINT.

### `client.destroy()` — force-close

`client.destroy()` calls `pool.destroy()`. Semantics:

1. State transitions directly to `'destroyed'`.
2. **All in-flight work is aborted.** Queued acquires reject with `PoolClosedError({ state: 'destroyed' })` → `ClientClosedError({ state: 'destroyed' })`. In-flight queries are driver-cancelled; their terminals reject with `AbortError`.
3. Connections close immediately.

Use this for shutdown deadlines, runaway processes, or test teardown where waiting for graceful drain isn't acceptable. Most production code uses `close()`.

### State model

The client surfaces state as `client.state: 'pending' | 'open' | 'draining' | 'destroyed'`. Transitions:

```
pending  → open       (connect() resolves)
pending  → destroyed  (connect() rejects, or destroy() called from pending)
open     → draining   (close() called)
open     → destroyed  (destroy() called)
draining → destroyed  (drain completes naturally, or destroy() called concurrently)
```

`pending` is the pre-connect state (or in the middle of an in-flight `connect()` attempt); `open` is the running state; `draining` is the graceful-shutdown window; **`destroyed` is terminal — no transitions out, the client cannot be revived**. To retry after a failed connect or to reconnect after a planned shutdown, the user constructs a fresh client (see "Retrying after a failed connect" above). Idempotency: `close()` and `destroy()` may be called any number of times; subsequent calls return the same Promise as the first.

The client's state is the canonical source of truth at the user-facing layer. The pool's `state` ([ADR-0011](0011-pool-port.md)) starts in `'open'` from construction (the pool itself doesn't know about the client's pre-connect window). The client adds `pending` above the pool's state machine and gates query dispatch on it.

**State changes publish on `mssql:client:state-change`** ([ADR-0014](0014-diagnostics.md)) with `{ from, to }` context, so cross-cutting consumers (APM lifecycle timelines, fleet observability, readiness probes flipping to 503 on `'draining'`) subscribe rather than poll `client.state`. For per-instance terminal-close handling (a manager updating its registry when one of its clients closes), the client also extends `EventEmitter` with a `close` event — see below.

### `Client` events

`Client extends TypedEventEmitter<ClientEvents>` with one event:

```ts
interface ClientEvents {
  close: [{ reason: 'connect-failure' | 'drain' | 'destroy'; error?: MssqlError }]
}
```

`close` fires once per client, when the client transitions to `'destroyed'`. The `reason` discriminates the cause:

| Reason | Triggered by | `error` payload |
|---|---|---|
| `'connect-failure'` | `connect()` rejection (`pending → destroyed`) | The `ConnectionError` / `CredentialError` that rejected |
| `'drain'` | `close()` completing graceful drain (`open` / `draining → destroyed`) | undefined |
| `'destroy'` | `destroy()` force-close (any state → `destroyed`) | undefined |

The full node `EventEmitter` API is available (`on`, `once`, `off`, `addListener`, `removeAllListeners`, etc.), typed to the single event in `ClientEvents`. The shape mirrors the `close` event on the driver-port `Connection` ([ADR-0010](0010-driver-port.md)): one event per object lifetime, reason disambiguates the teardown source. There is no `'error'` event — connect / runtime failures surface through Promise rejections (on `connect()` or query terminals), and `close({ reason: 'connect-failure', error })` carries the connect failure for subscribers wanting it on the lifecycle event. No `'error'` event also means no node-`EventEmitter` no-listener-crash hazard: a `Client` whose connect failed cannot take the process down by emitting unhandled `'error'`.

**The `close` event and the `mssql:client:state-change` channel serve different audiences.** The event is per-instance, for code holding a client reference; `client.once('close', cleanup)` is the natural shape for "tell me when this specific client closes." The channel is process-wide telemetry covering every client and every transition (including non-terminal ones like `open → draining`); APM tools subscribe to it without needing references to specific client instances. Both surfaces fire from the same internal transition, in a deterministic order on the `'destroyed'` transition: state changes synchronously, the `close` event fires synchronously, the `mssql:client:state-change` channel publishes, and any pending Promise (the originating `close()` / `destroy()` / `connect()` call) settles last. A `close` event handler observing `client.state` sees `'destroyed'`; a Promise-await consumer sees the state has already transitioned.

### Error surfacing summary

| Phase / event | Error class | Surfaces at |
|---|---|---|
| Query before `connect()` | `ClientNotConnectedError` | rejection of the query terminal (or first iterator `next()` for `for await`) |
| Connect failure | `ConnectionError` / `CredentialError` | rejection of `client.connect()` |
| Query during normal operation | various ([ADR-0017](0017-error-taxonomy.md)) | rejection of the query terminal |
| Query / new acquire after `close()` or `destroy()` | `ClientClosedError({ state })` | rejection of the query terminal / acquire |
| In-flight query during `destroy()` | `AbortError` (driver-cancelled) | rejection of the query terminal |
| New acquire racing `close()` | `ClientClosedError({ state })` | rejection of the acquire / query terminal |

## Consequences

- Startup errors are caught at one well-defined place (`client.connect()`'s promise rejection). Background pool populate can never produce uncaught promise rejections, because it does not happen without an awaited caller.
- Graceful drain (`close()`) is the default shutdown shape, matching SIGTERM / Kubernetes-style lifecycle expectations: stop new work, let in-flight finish, then close.
- Force-close (`destroy()`) is available for the cases that need it — test teardown, shutdown deadlines, runaway processes.
- Pre-connect queries fail fast with a typed error; users can't accidentally queue queries before the pool is ready, and the bug shows up on the line that fired the query rather than seconds later.
- Client state is observable via `client.state`, useful for diagnostics dashboards and lifecycle-aware code.
- The client's `pending` state has no analog in the pool — it sits above the pool, modelling "the user has constructed a client but hasn't validated it yet." The pool itself is in `'open'` from creation, accepting acquires that the client's dispatcher gates from reaching it.
- `'destroyed'` is terminal. Users wanting retry-on-failure or reconnect-after-shutdown construct a fresh client; the state machine stays simple (no per-lifetime Promise idempotency, no per-lifetime listener semantics, no "is this our first connect?" reasoning). The cost is one extra `createClient(config)` line at the call site.
- Per-instance close handling is supported via `client.once('close', cb)` — the `Client` extends `EventEmitter` with a single `close` event whose `reason` discriminates connect-failure / drain / destroy paths. Cross-cutting state observability uses `mssql:client:state-change` ([ADR-0014](0014-diagnostics.md)). Two surfaces, two audiences (per-instance reference holders vs process-wide telemetry).

## Alternatives considered

**Lazy-only — no `connect()`, queries trigger pool populate.** Rejected because background pool populate has no awaited caller; auth / network / misconfig errors during populate become uncaught promise rejections that crash the process. The `connect()` model is the standard answer; v12 already has it; users coming from .NET / JDBC / pg expect it.

**Queue queries fired before `connect()`.** Considered. Rejected because it creates ambiguity about when queries actually fire (before or after connect resolves?) and hides config errors that should surface at startup. Fail-fast with `ClientNotConnectedError` is clearer.

**`close()` aborts in-flight acquires.** Rejected — that's the v12 pattern that produces surprise errors during shutdown. The standard graceful pattern is "stop new work, finish in-flight." `destroy()` is the explicit force-close for the cases that need it.

**Single `close()` method with a force flag (`close({ force: true })`).** Considered. Rejected because two methods are clearer at the call site: `close()` is graceful, `destroy()` is force. A boolean flag has the wrong default direction (graceful is the default; users would have to remember to opt out for force) and reads worse than two named methods.

**Allow `connect()` to revive a `destroyed` client.** Considered, briefly specced in an earlier draft. Rejected on reconsideration because it complicates the state machine with concepts that don't earn their keep: per-lifetime Promise idempotency (`close()` returns one Promise this lifetime, a different one next), per-lifetime listener semantics (does `client.once('close')` fire once per lifetime or once ever?), and "is this the first time we've connected, or the third?" reasoning. The friction of recreating a client to retry is one extra `createClient(config)` call at the call site — the same config the user already constructed once — and the simplification of "destroyed is destroyed, full stop" is worth more than the saved line. Users wanting retry-on-transient-failure write a small backoff loop around `createClient` + `connect`, not around `connect` alone.

**No `EventEmitter` on the client at all (rely solely on `mssql:client:state-change`).** Considered. Rejected because per-instance close handling is a real need that the channel doesn't address well — a manager owning multiple clients wants `client.once('close', cleanup)` to update its registry when each client closes, and `diagnostics_channel` is process-wide telemetry, not per-instance observation. Filtering channel events by some client identifier and dispatching back to per-instance handlers reinvents what `EventEmitter` already provides. The chosen design — `Client extends TypedEventEmitter<ClientEvents>` with a single `close` event mirroring the driver-port `Connection`'s pattern ([ADR-0010](0010-driver-port.md)) — keeps the per-instance affordance idiomatic while leaving cross-cutting telemetry on the channel.

**`Client` exposes `'state-change'` / `'open'` / `'draining'` / `'connect'` events on the `EventEmitter`.** Considered. Rejected because the only per-instance lifecycle observation that's actually useful at a client reference holder's level is "this client closed" — non-terminal transitions (`pending → open`, `open → draining`) are interesting for fleet telemetry (covered by the channel) but rarely for per-instance reaction. Multiplying event names on the `EventEmitter` surface to mirror the channel's per-transition granularity would duplicate observability work without serving a use case. One event, one purpose; channel covers the rest.

**Drop the `pending` state — pool is `'open'` from creation, queries before `connect()` just queue.** Rejected because the user can do meaningful things between `createClient()` and `connect()` — at minimum, fail loudly with `ClientNotConnectedError` rather than silently queuing. The state distinction is observable and lets users gate code on "is the client ready?" without inspecting pool internals.

**Auto-`connect()` on first query.** Considered as a convenience. Rejected because it hides the connect step and reintroduces the uncaught-rejection problem under load (multiple concurrent first queries each try to trigger connect; the rejection of one becomes an uncaught error in the others). Explicit `connect()` is one extra line and removes the entire class of confusion.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — `createClient` and the queryable surface.
- [ADR-0011: Pool port](0011-pool-port.md) — pool state model and the drain/destroy semantics this ADR layers on.
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md) — `ClientNotConnectedError`, `ClientClosedError`, `ConnectionError` class identities.
