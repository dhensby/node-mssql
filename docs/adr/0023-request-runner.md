# ADR-0023: `RequestRunner` — connection acquisition for `Query<T>`

- **Status:** Draft
- **Date:** 2026-05-06
- **Deciders:** @dhensby

## Context

[ADR-0006](0006-queryable-api.md) settles `Query<T>` as the user-facing object every terminal hangs off, [ADR-0008](0008-query-lifecycle-and-disposal.md) settles its lifecycle (lazy until terminal, single-consumption, cancel on dispose), and [ADR-0011](0011-pool-port.md) settles the `Pool` port. None of them specify **how `Query<T>` actually gets a `Connection`** when a terminal fires. The shape of that acquisition step varies by scope:

- **Pool-bound `sql`** — every terminal call boils down to `pool.acquire()` → `connection.execute()` → `pool.release()`, with the release tied to the stream ending (drain, error, cancel, or break).
- **`ReservedConn`** — `sql.acquire()` already holds one connection for the disposable's lifetime. Queries against it must use *that* connection; per-query acquire/release would re-pool through the connection the user explicitly pinned.
- **`Transaction` / `Savepoint`** — the scope itself owns the connection from `BEGIN` through `COMMIT`/`ROLLBACK`. Every query inside the scope uses the same connection; release happens when the transaction terminates, not at each query's end.

[ADR-0008](0008-query-lifecycle-and-disposal.md) also notes that early termination (`break`, `.cancel()`, `AbortSignal`, `.dispose()`) must end with the connection back in the pool — none of the cancel paths can leak. That is a connection-acquisition concern, not a `Query<T>` concern.

A clean abstraction is needed before the kernel runtime lands. It must (a) keep `Query<T>` uniform across scopes, (b) put release-on-stream-end in one well-defined place, (c) compose cleanly with the consumer-supplied `AbortSignal` plus `Query<T>`'s own cancel control, and (d) be testable without spinning up a real `Pool`.

## Decision

Introduce **`RequestRunner`** — a single-method port that maps an `ExecuteRequest` to an `AsyncIterable<ResultEvent>`, with connection acquire and release internalised:

```ts
interface RequestRunner {
  run(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent>
}
```

`Query<T>` holds a `RequestRunner` reference (provided at construction by whatever scope built the Query) and consumes its `AsyncIterable<ResultEvent>` through whatever terminal fired. Every scope wires up the runner appropriate to its semantics. The runner is internal — users never construct one directly; they get a `Query<T>` from `` sql`...` `` (or `conn.tag`...``, or `tx.tag`...``) and the scope has already attached the right runner under the hood.

### Per-scope runner shapes

| Scope | Runner constructs | Acquire | Release |
|---|---|---|---|
| Pool-bound | wraps `Pool` | per-call (`pool.acquire(signal)`) | per-call, on stream-end (drain / error / `iter.return()`) |
| `ReservedConn` | wraps the held `Connection` | no-op (already held) | no-op (lifetime owned by the scope) |
| `Transaction` | wraps the tx-pinned `Connection` | no-op | no-op (release on `commit()`/`rollback()`) |
| `Savepoint` | inherits the enclosing transaction's runner | no-op | no-op |

Pool-bound implementation pattern (shape only — concrete code lands with the kernel runtime):

```ts
function poolRunner(pool: Pool): RequestRunner {
  return {
    run(req, signal) {
      return (async function* () {
        const pooled = await pool.acquire(signal)
        try {
          for await (const event of pooled.connection.execute(req, signal)) {
            yield event
          }
        } finally {
          await pooled.release()
        }
      })()
    },
  }
}
```

The async generator's `try/finally` is the *single place* connection release lives for the pool-bound path. Whether the consumer drains naturally, throws mid-stream, breaks early from a `for await` loop, or aborts via signal, the iterator's `return()` triggers `finally` and the connection lands back in the pool.

For scopes that already hold a connection, `run()` just delegates: `return conn.execute(req, signal)`. No async-generator wrapper, no per-call acquire/release. The runner is the seam where "I own a connection" vs "I need to acquire one" lives — and `Query<T>` doesn't have to know which side it is on.

### Cancellation and signal composition

`Query<T>` owns a private `AbortController` for `.cancel()` and `.dispose()` (the latter calls the former). The signal threaded into `runner.run(req, signal)` is composed from the consumer's signal (passed via the scope's `.signal()` builder method, or `defaultTimeout`-derived) and `Query<T>`'s own controller signal:

```ts
const composite = signal !== undefined
  ? AbortSignal.any([signal, this.#ownController.signal])
  : this.#ownController.signal
```

Either side firing aborts the request: an external timeout via `signal`, or an internal `.cancel()`/`.dispose()` via the controller. `AbortSignal.any` (Node 20.3+, our minimum target per [ADR-0003](0003-runtime-targets.md)) is the load-bearing primitive — it lets us compose without managing a listener manually.

The runner forwards `signal` to `pool.acquire(signal)` and to `connection.execute(req, signal)`. The pool port already specifies signal-driven cancellation ([ADR-0011](0011-pool-port.md)) and the driver port does likewise ([ADR-0010](0010-driver-port.md)). The runner is a passthrough — it does not invent its own cancellation, nor does it own timeouts. It just holds the connection-lifecycle guarantee.

### Why not put `pool.acquire` directly on `Query<T>`

A simpler-looking design would have `Query<T>` accept a `Pool` and do the acquire/release internally. We reject that for three reasons:

1. **Scope flexibility.** `ReservedConn` and `Transaction` don't have a pool to acquire from — they have a held connection. Forcing `Query<T>` to talk to a `Pool` either invents a wrapper-pool that always returns the same connection (extra surface for a contrived case) or ships two different Query implementations (unification lost).
2. **Testability.** A `FakeRunner` is ten lines (an async generator yielding canned events). A `FakePool` requires implementing `Pool`, `PooledConnection`, and a `Connection`. The runner abstraction lets unit tests for terminals, lifecycle, multi-rowset semantics, etc. focus on the Query without spinning up the pool stack.
3. **Future custom executors.** Diagnostics-channel-only tracing modes, retry wrappers, request-rewriting middleware — anything that wants to interpose between `Query<T>` and the wire — fits as a `RequestRunner` layer. Putting `pool.acquire` directly on `Query<T>` would require those to all come up through the `Pool` port, expanding *its* surface for concerns that aren't pooling.

`RequestRunner` is one internal seam; layering on top of it stays additive.

### Construction site

The Client owns the per-scope wiring. `createClient` constructs the pool-bound runner once (wrapping the user's `pool` factory's output) and the `sql` tag returned to the user is bound to that runner. `sql.acquire()` constructs a `ReservedConn`-bound runner over its acquired `PooledConnection`; `sql.transaction()` constructs a transaction-bound runner over its pinned connection. Each builder returns a `Query<T>`-callable scope that has the right runner attached — users never see the runner type, only the queryable they are calling.

The runner construction site for any given scope happens *once* (per scope instance), not per query — the scope holds the runner, and every `` sql`...` `` call against that scope hands the runner reference into the `Query<T>` it constructs. Cheap.

## Consequences

- `Query<T>` is uniform across scopes. The same class, the same terminals, the same lifecycle — only the runner reference differs. A `function takeAQuery(q: Query<T>)` works identically with a pool-bound, reserved-conn-bound, or transaction-bound query.
- Connection release for the pool-bound path lives in *one* place: the `poolRunner`'s async-generator `finally` block. Every cancel path (drain, error, `iter.return()`, signal abort) runs through it. There is no second release path that could diverge from the first.
- Tests for `Query<T>` use a hand-rolled `FakeRunner` that yields canned `ResultEvent[]`. No `Pool` / `Connection` test fixtures needed for terminal / lifecycle / shape-mapping tests.
- The runner abstraction is internal. There is no public `RequestRunner` factory the user constructs — they get queryables (the pool-bound `sql`, `await using conn = sql.acquire()`, etc.), and scopes wire runners under the hood.
- A future feature that wants to interpose on the wire (a retry wrapper, an outbound-SQL rewriter, a per-request tracing layer) lands as a `RequestRunner` decorator without changing `Query<T>`.

## Spike findings (V-1)

Validated by a vertical-slice cut implementing the runner + a minimal `Query<T>` (`.then()` + `.all()` only) tested against a hand-rolled `FakeRunner` that simulates the pool-bound async-generator `try/finally` pattern:

- The async-generator `try/finally` releases the connection on **every** consumed-stream exit path tested — natural drain (the `done` event from the runner), runner-side errors (the runner throws mid-stream), and Query-internal throws that interrupt the for-await loop (`MultipleRowsetsError` fires when a second `metadata` token arrives, and the for-await's auto-`iter.return()` propagates into the runner's `finally`). The pattern is sound.
- `Query<T>` constructed with `{ runner, request, signal }` reads cleanly. Lazy execution is straightforward — the runner is only invoked when a terminal fires, never at construction.
- A `FakeRunner` is a 15-line async generator yielding canned `ResultEvent[]` — zero `Pool` / `Connection` fixture surface needed to test `Query<T>` shape mapping, single-consumption, multi-rowset detection, and release-on-end.

## Open questions

These remain for kernel-runtime work to resolve, then refined back into this ADR before promoting to Accepted.

1. **Naming.** `RequestRunner` vs `RequestExecutor` vs `QueryExecutor` vs something domain-specific. Current name is `RequestRunner` because it `run(...)`s a request; the V-1 spike found no friction with it. Revisit only if a clearer noun emerges during the round-out commits.
2. **`ping()` on the runner.** [ADR-0011](0011-pool-port.md) specifies `sql.ping()` for `onAcquire`/`onRelease` hook bodies. V-1 confirms ping does **not** belong on `RequestRunner` — the runner's job is `run(req, signal): AsyncIterable<ResultEvent>`, not "any operation against a connection." Ping lives on `Connection` (the driver port) and surfaces through the `Queryable` wrapper that hooks receive (which holds a specific bound connection for the hook's duration). Resolved.
3. **Construction signature.** V-1 went with `new Query({ runner, request, signal })` (options-object). Reads cleanly, extends well to additional fields (`raw`, `id`, etc.) without churning call sites. Resolved.
4. **Per-scope signal threading.** When a `ReservedConn` exposes its own `.signal()` builder method on a query, does that signal compose with the `ReservedConn`'s own cancellation signal (if it has one), or only with the Query's controller? Touches `ReservedConn`'s scope semantics, which are defined in [ADR-0006](0006-queryable-api.md) but not yet down to signal-composition specifics. Resolve when the scope-builder runtime lands (round-out commit R-4).
5. **Multi-rowset and `iter.return()`.** [ADR-0006](0006-queryable-api.md) distinguishes inner-break (advance past current rowset) from outer-break (cancel request) for `.rowsets()`. The runner sees only the outer iterator's `return()`; the inner-rowset advance must be handled inside `Query<T>`'s `.rowsets()` implementation, draining the current rowset's remaining rows from the runner stream before yielding the next rowset. Validate this is workable when `.rowsets()` lands (round-out commit R-2).

## Alternatives considered

**`Query<T>` accepts a `Pool` directly.** Rejected — see "Why not put `pool.acquire` directly on `Query<T>`" above. The summary: scope flexibility, testability, and future executor middleware all argue for the seam.

**`QueryBuilder` produces a plan; `Executor.run(plan)` returns the executing `Query<T>`.** Considered — it is the textbook decoupling. Rejected because it adds a second user-facing object (the plan) that buys nothing in the public API: the user already writes `` sql`...` `` and gets back something they can `await`, `for await`, `.raw()`, etc. Splitting that into "plan + execute" doubles the cognitive load for a separation users do not need to see. The internal `RequestRunner` already gives us the decoupling where it actually matters (testing, scope variation, middleware) without burdening the surface.

**Push the `Connection` into `Query<T>` at construction (no runner — just hold the connection).** Considered for `ReservedConn` / `Transaction` scopes where the connection is already held. Rejected because the pool-bound case still needs lazy acquire-on-terminal — the user can build a `Query<T>` and never fire a terminal, in which case no connection should be touched. A `Connection` reference at construction time forces eager acquire, breaking the laziness contract from [ADR-0008](0008-query-lifecycle-and-disposal.md). The runner is the layer that bridges "lazy in pool-bound mode" with "already-held in scoped mode."

**Make `Query<T>` itself an `AsyncIterable<ResultEvent>` and let consumer code do the row-shaping.** Considered as a more functional design. Rejected because row shaping (object form, raw form, last-wins on duplicate names), trailer accumulation (`info`, `print`, `envChange`, `rowsAffected`, `output`, `returnValue`), and `MultipleRowsetsError` detection are all `Query<T>` concerns the kernel must own — they are part of [ADR-0006](0006-queryable-api.md) / [ADR-0007](0007-query-result-presentation.md)'s public contract. Pushing them onto consumer code is a bigger break than this ADR is empowered to make.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — `Query<T>` shape and terminals.
- [ADR-0007: Query result presentation](0007-query-result-presentation.md) — row shaping, trailer data, `MultipleRowsetsError`.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — laziness, cancel paths, `await using` contract.
- [ADR-0010: Driver port](0010-driver-port.md) — `Connection.execute(req, signal): AsyncIterable<ResultEvent>`.
- [ADR-0011: Pool port](0011-pool-port.md) — `pool.acquire(signal)`, signal-driven cancellation, hook lifecycle.
- [ADR-0013: Cancellation and timeouts](0013-cancellation-and-timeouts.md) — `AbortSignal` as the single cancellation primitive.
