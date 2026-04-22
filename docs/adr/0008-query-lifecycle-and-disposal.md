# ADR-0008: Query lifecycle and disposal — laziness, exit paths, and `await using`

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

[ADR-0006](0006-queryable-api.md) settles the queryable API shape and terminal set. Several lifecycle questions follow but are large enough to merit their own ADR:

- When does a `Query<T>` actually do work? Eager or lazy execution decides what dropping a built-but-never-used `Query` costs.
- What are the exit paths? Natural drain, early `break` from `for await`, explicit `.cancel()`, `AbortSignal`, `.dispose()`, the `.columns()`-only "shape but no rows" case — each must end with the connection clean and back in the pool.
- What does `.dispose()` mean on a `Query` that is currently flowing rows? The naive answer (wait for the stream to settle) is cleverer than the cross-language `await using` contract; the predictable answer (cancel) creates a sharp footgun for the `return q.all()` helper pattern. Pick one and document the consequence.
- The library has many user-facing types with lifetimes — `ReservedConn`, `Transaction`, `Savepoint`, `PreparedStatement`, and `Query` itself. They should expose one cleanup verb (`.dispose()`) consumers can rely on, with named domain methods where they carry distinct meaning.

This ADR records lifecycle and disposal as a child of ADR-0006.

## Decision

### Lifecycle, drain, and cancellation

`Query<T>` execution is **lazy** — the tag call builds the object but does not touch the connection or send anything to the server. A connection is only acquired when a terminal fires (`await`, `for await`, `.all()`, `.iterate()`, `.run()`, `.rowsets()`, `.columns()`). `.raw()` is not in this list — it is a view toggle that returns a new `Query<R[]>`, and execution starts when a terminal fires on the returned Query, not on the `.raw()` call itself ([ADR-0007](0007-query-result-presentation.md)). This is the load-bearing property of the design: it means dropping a built-but-never-consumed `Query` leaks nothing.

Once a terminal fires, the driver pipes the server's response over a single logical request on the acquired connection. The connection is held by this query until the response drains or the request is cancelled — it cannot service another request in the meantime, but it returns to the pool cleanly afterwards either way. The API handles each exit path:

- **Early termination via `for await`** — breaking, returning, or throwing inside the loop invokes the iterator's `return()` method, which asks the driver to cancel the request. The connection returns to the pool immediately. `mssql:query:aborted` fires with `reason: 'early-terminate'`.
- **`.columns()`-only consumption** — calling `.columns()` without a subsequent row-consuming terminal leaves the stream held by driver backpressure mid-response (see [ADR-0007](0007-query-result-presentation.md) for the backpressure model). `.dispose()` on the Query (explicit, or via `await using`) asks the driver to cancel the request, and the connection returns to the pool clean. This is the explicit "the caller asked for the shape but not the rows" path. `mssql:query:aborted` fires with `reason: 'early-terminate'`.
- **Explicit cancellation via `.cancel()` or `AbortSignal`** — `Query.cancel()` and aborting the signal both issue the driver-level cancel; the connection returns to the pool cleanly, and the next acquirer picks it up like any other release. No connection is wasted on the happy cancel path. The pool adapter only destroys a connection when the cancel itself leaves it in an unrecoverable state — a validate-failure concern owned by the adapter, not the query lifecycle. `mssql:query:aborted` fires with `reason: 'user-abort'`. The exact cancel mechanism is the driver's concern — the kernel asks the `Connection` to cancel and the driver decides how to communicate that to the server.

**`.dispose()` on `Query<T>` cancels any in-flight stream.** Per the uniform disposal contract (see §Disposables), `await using` (or an explicit `.dispose()` call) ends the Query's lifetime, and a Query whose lifetime has ended cannot keep producing rows. Two cases:

1. **No terminal fired (no stream)** — no-op. No connection was acquired, nothing to release.
2. **A terminal has fired** — ask the driver to cancel the request. The connection returns to the pool clean. Once the stream has terminated, `meta()` returns with `cancellation: { reason: 'early-terminate' }` and `completed: false`. This holds regardless of whether the stream was flowing (a consuming terminal was reading rows), held by backpressure (`.columns()` resolved with no row consumer), or in between.

**Both cases mark the Query as disposed.** A subsequent terminal call (`.all()`, `for await`, `.run()`, `.rowsets()`, `.columns()`) on a disposed Query throws `TypeError` — the Query's lifetime has ended, and a Query whose lifetime has ended cannot start new work. This is true even in case 1, where dispose itself was a no-op: "nothing to cancel" does not mean "leave a usable Query behind." The `await using` scope has ended, so the Query has ended. This is what makes the "return q from a using scope" footgun fail loudly at the caller rather than silently working by accident.

This matches the `await using` contract every other `AsyncDisposable` ships with — the variable falls out of scope, the resource is released, end of story. Trying to be cleverer (e.g. having dispose wait for in-flight terminals to settle) would require it to inspect internal stream state and pick a branch, which is a library-specific contract on top of a language-wide one. We default to the simpler, more predictable rule: scope ends → cleanup runs → query is done.

The implication for the helper-that-returns pattern: returning a promise that depends on `q` without first awaiting it inside the scope is a bug — the dispose runs as the function returns and cancels the in-flight query.

```ts
// Wrong: q.all() is still in-flight when dispose fires; the caller sees an AbortError.
async function getRows() {
  await using q = sql`select * from users`
  return q.all()
}

// Right: await before returning, so the materialised array survives the scope exit.
async function getRows() {
  await using q = sql`select * from users`
  return await q.all()
}

// Footgun: returning the Query itself disposes it; the caller's first terminal call throws TypeError.
async function makeQuery() {
  await using q = sql`select 1`
  return q
}

// Right (helper pattern): the factory returns the unbound Query; the caller owns the using scope.
function userQuery(id: number) {
  return sql`SELECT * FROM users WHERE id = ${id}`
}
async function getUser(id: number) {
  await using q = userQuery(id)
  return await q.all()
}
```

`.cancel()` and `.dispose()` have the same effect on an in-flight stream — both issue the driver-level cancel. They differ in *how* they fire: `.cancel()` is an explicit method call (or fires from an `AbortSignal`) and can run mid-scope without ending it; `.dispose()` runs automatically when the `await using` scope exits. Users who want to cancel without leaving the scope reach for `.cancel()`; users who let the scope end let dispose do the work.

The one pattern worth documenting as a footgun is **a terminal was never called** — the user built a `Query` and then forgot to `await` or iterate it, typically a missing `await` on a DML statement:

```ts
sql`update t set x = 1 where id = ${id}`  // oops — never awaited, no update happens
```

This is a correctness bug (the DML never runs), not a resource leak — because execution is lazy, no connection was acquired and nothing needs to be drained. The library does not ship runtime detection for the missing-`await` case in v13.0; lint rules (no-floating-promises and similar) plus code review are the right tools. A `FinalizationRegistry`-based dev-mode detector is a plausible future addition (its own ADR), but the implementation cost and runtime caveats are larger than is appropriate to commit to here.

### `AsyncDisposable` compatibility

Every `.dispose()` method is paired with `[Symbol.asyncDispose]` so `await using` works out of the box on any supported runtime ([ADR-0003](0003-runtime-targets.md)). TypeScript 5.2+ and tslib handle the runtime concerns end-to-end — no library-side polyfill is needed. Class bodies use `[Symbol.asyncDispose]` directly.

**Callers not using TypeScript 5.2+ or Node 22.12+ must call `.dispose()` manually.** `await using` is syntax, not a runtime feature — JavaScript consumers on older toolchains, or plain Node without TS downlevel emit, do not get automatic disposal. The library's API surface is explicit: every disposable type ships a named `.dispose()` method that those users call themselves. The named domain methods (`.release()`, `.commit()`, `.rollback()`, `.unprepare()`, `.cancel()`) are always available as alternatives.

### Disposables — uniform `.dispose()`

Every user-facing type with a lifetime exposes `.dispose()` and `[Symbol.asyncDispose]`. This gives consumers one verb they can reach for regardless of type — generic cleanup code (`async function withCleanup(x: AsyncDisposable)`) works uniformly — while also letting domain-fluent code reach for the named method where one exists.

| Type | `.dispose()` does | Named alternatives |
|---|---|---|
| `ReservedConn` | release connection to pool | `.release()` |
| `Transaction` | rollback if not committed or rolled back | `.commit()`, `.rollback()` |
| `Savepoint` | rollback-to if not released or rolled back | `.release()`, `.rollback()` |
| `PreparedStatement` | release the prepared handle + release pinned connection | `.unprepare()` |
| `Query<T>` | cancel any in-flight stream (see Lifecycle above) | `.cancel()` (explicit, same effect) |

Three conventions keep the table coherent:

1. **`.dispose()` is idempotent.** Calling it twice does not throw; subsequent calls resolve with no effect.
2. **Domain methods and `.dispose()` are siblings, not nested.** Calling `.commit()` moves the transaction to the committed terminal state; the subsequent `.dispose()` (from `await using` or an explicit call) sees there is nothing to do and is a no-op. Users are free to mix — `await tx.commit()` followed by the using-scope ending is the common path.
3. **`.cancel()` and `.dispose()` have the same effect on `Query<T>`** — both cancel any in-flight stream. They differ in *how* they fire: `.cancel()` is an explicit method call (or triggered by an `AbortSignal`) that can run mid-scope without ending the scope; `.dispose()` runs automatically when the `await using` scope exits. The named alternative exists because cancelling mid-scope is a meaningful action — e.g. an external timeout firing should not have to close the user's enclosing transaction.

**On SAVEPOINT release.** SQL Server savepoints are transaction markers, not resources — the wire protocol does not have a `RELEASE SAVEPOINT` verb (unlike Postgres or SQLite). `Savepoint.release()` is an API-level marker that clears the savepoint from the library's rollback-target list so a later `.rollback()` on the outer transaction rolls to the prior savepoint (or the transaction start) instead. No round-trip to the server is made. This is documented here because the uniform `.dispose()` table listing `.release()` as a domain method could otherwise imply a server round-trip that does not exist.

## Consequences

- Every user-facing type with a lifetime exposes `.dispose()` and `[Symbol.asyncDispose]`, so one generic verb works regardless of type; named domain methods (`.release()`, `.commit()`, `.rollback()`, `.unprepare()`, `.cancel()`) remain available where they carry distinct meaning. `Query.dispose()` cancels any in-flight stream — matching the cross-language `await using` contract where the variable falling out of scope ends the resource's lifetime.
- The `return q.all()` pattern is a bug (the dispose runs before the caller can read the result, raising `AbortError`); `return await q.all()` is the correct form. The library does not try to rescue the wrong pattern — failing loud at runtime preserves a single, predictable rule: scope ends, cleanup runs, query is done. Consumer education is one bullet in a guide.
- Lazy execution means a missing `await` is a correctness bug (the DML never runs) but not a resource leak. v13.0 ships no runtime detector for this — lint rules and code review remain the right tools. A `FinalizationRegistry`-based detector is a plausible future ADR if real-world usage shows it would carry its weight.
- `await using` works on every supported runtime ([ADR-0003](0003-runtime-targets.md)) without library-side polyfilling — TypeScript 5.2+ emits the disposal helpers, and Node 22.12+ provides native support; the helpers prefer the native symbol when present. Users on older toolchains call `.dispose()` explicitly.
- All cancellation paths (early `break`, `.cancel()`, `AbortSignal`, `.dispose()`) end with the connection back in the pool — never destroyed unless the cancel left it in an unrecoverable state, which is the pool adapter's concern. The kernel does not waste connections on the happy cancel path.
- `Savepoint.release()` is an API-level no-op that clears the rollback target — no server round-trip, because TDS has no `RELEASE SAVEPOINT` verb. The uniform `.dispose()` table calls this out explicitly so users do not assume parity with Postgres / SQLite savepoints.

## Alternatives considered

**State-based `Query.dispose()` (wait-if-flowing, cancel-if-no-consumer).** Considered as a way to make the `return q.all()` helper pattern work without an explicit `await`. Dispose would inspect the stream — in-flight consuming terminal → wait for it to settle; `.columns()`-only stream with no row consumer → ask the driver to cancel — and pick the right branch automatically. Rejected for two reasons. First, it silently rescues a pattern that is wrong everywhere else in JavaScript: returning a promise from inside an `await using` scope without awaiting it loses the result the moment the scope exits. The library's "kindness" would train a wrong mental model that does not generalise to any other `AsyncDisposable`. Second, dispose-time stream-state inspection is cleverer than the cross-language `await using` contract, increasing the cognitive load of the library's surface for marginal ergonomic gain. The chosen design — dispose always cancels — matches `await using` semantics everywhere else, fails the bad pattern loudly with a recognisable `AbortError`, and is one rule for users to internalise. If real-world usage shows the loud failure causes more friction than it teaches, the state-based design can be added later as a non-breaking refinement.

**Drain-on-dispose (pull all remaining rows, then release).** An earlier sketch had `.dispose()` pull the rest of the stream into a discard buffer before releasing the connection. Rejected — for `.columns()`-only consumption on a wide rowset, this means transferring megabytes of decoded rows just to throw them away. A driver-level cancel ends the work in O(1) network bytes and returns the connection in the same state.

## References

- [ADR-0003: Runtime targets](0003-runtime-targets.md) — TypeScript 5.2+ tslib helpers, Node 22.12+ native `Symbol.asyncDispose`.
- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parent decision; terminal set this lifecycle applies to.
- [ADR-0007: Query result presentation](0007-query-result-presentation.md) — `.columns()`-pause mechanism that creates one of the dispose cases.
- [TC39 Explicit Resource Management proposal](https://github.com/tc39/proposal-explicit-resource-management) — `await using` and `Symbol.asyncDispose`.
