# ADR-0009: Stored procedures and prepared statements as re-executable templates

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

[ADR-0006](0006-queryable-api.md) settles the queryable API shape: one callable, a `Query<T>` that is both `PromiseLike<T[]>` and `AsyncIterable<T>`, and a small set of cardinality-named terminals. Two query kinds share enough structure to be unified but enough deviation to need their own ADR:

- **Stored procedures** have typed inputs (`@id INT`), typed outputs (`@assigned NVARCHAR(50) OUTPUT`), and a return status. The output channel is a distinct return shape that does not fit cleanly through a tagged template — the type system needs to know, at the call site, what `output` keys exist.
- **Prepared statements** have the same input typing, but their lifecycle is materially different: `sp_prepare` creates a server-side handle that is **connection-pinned** and must be released with `sp_unprepare`. A first-execute / re-execute / dispose lifecycle has to be modelled.

Both are meaningfully *re-executable* — the same template gets fed different argument sets — which is something raw-tag `sql\`...\`` Queries deliberately are not (each tag call is single-use; see [ADR-0006](0006-queryable-api.md) and [ADR-0008](0008-query-lifecycle-and-disposal.md)). Better-sqlite3's `Statement` and pg's prepared-statement handles establish the builder + bind pattern as the durable shape for this.

## Decision

### Re-executable templates

Stored procedures and prepared statements share one shape — a **re-executable query template** with typed inputs and outputs. The builder surface is `.input()` / `.output()` / `.inout()` (shaping) and `.bind(args)` (producing a fresh executable). The only differences are what `sql.procedure()` vs `sql.prepare()` bind to on the server side, and the lifecycle of the prepared-statement handle.

```ts
// Stored procedure: the name is the server-side target.
sql.procedure('sp_get_user')
  .input('id', types.Int)
  .output('name', types.NVarChar(50))
  .bind({ id: 1 })     // -> Procedure<T, O> extends Query<T, O>

// Prepared statement: text + typed slots compile to an sp_prepare handle.
sql.prepare('select * from users where id = @id')
  .input('id', types.Int)
  .bind({ id: 1 })     // -> PreparedBinding<T, O> extends Query<T, O>
```

Both `Procedure<T, O>` and `PreparedBinding<T, O>` **extend `Query<T, O>`** — every terminal (`await`, `for await`, `.all()`, `.iterate()`, `.raw()`, `.columns()`, `.run()`, `.rowsets()`, `.meta()`) works identically to a tag call. Consumers written against `Query` accept either without caring which it is:

```ts
function fetchRows<T>(q: Query<T>): Promise<T[]> { return q.all() }
fetchRows(sql`select * from users`)                                // raw query
fetchRows(sql.procedure('sp_list_users'))                          // procedure
fetchRows(sql.prepare('select * from users').bind({}))             // prepared
```

Both diverge from raw-tag Queries in exactly one way: **they are re-executable**. A raw `sql\`...\`` Query is single-consumption (second `await` throws — see [ADR-0006](0006-queryable-api.md)). Procedures and prepared statements are *templates*: `.input()` / `.output()` / `.inout()` build the schema, `.bind(args)` stamps a set of arguments onto it, and every terminal call on the resulting bound query spins up a fresh internal `Query` for a fresh round-trip. This matches the builder patterns prior art is built on (better-sqlite3's `Statement`, pg's prepared-statement handles): the template is a reusable factory.

```ts
// Procedure: define once, execute many times — each await is a fresh server round-trip.
const getUser = sql.procedure('sp_get_user').input('id', types.Int)
const alice = await getUser.bind({ id: 1 })
const bob   = await getUser.bind({ id: 2 })

// Zero-arg procs are directly awaitable — no .bind({}) ceremony.
const users = await sql.procedure('sp_list_users')
for await (const u of sql.procedure('sp_list_users')) handle(u)

// Output parameters — exposed via .meta() (see ADR-0007).
const q = sql.procedure('sp_upsert')
  .input('id', types.Int)
  .output('assigned', types.NVarChar(50))
  .bind<User, { assigned: string }>({ id: 42 })
const [row] = await q
const { output, returnValue } = await q.meta()     // { assigned: string }, number

// Multiple rowsets.
const [headers, lines] = await sql.procedure('sp_get_order')
  .input('id', types.Int)
  .bind({ id: 7 })
  .rowsets<[OrderHeader, OrderLine]>()
```

`.bind()` returns a new bound Query (`Procedure<T, O>` or `PreparedBinding<T, O>`), so the same re-executable semantics carry through. Calling `.bind()` again — on the base template or on a previously-bound one — produces another fresh bound Query with the new argument set; earlier binds are unaffected. Builder methods (`.input()`, `.output()`, `.inout()`, `.bind()`) are **immutable-fluent**: each returns a new template rather than mutating the receiver, so a pre-configured `getUser` can be handed to multiple callers without interference.

### Prepared statements: lifecycle

Prepared statements differ from procedures in one respect: the server-side handle (from `sp_prepare`) is **connection-pinned** and must be **explicitly released** with `sp_unprepare`. `sql.prepare()` returns a `PreparedStatement` that is simultaneously a callable template *and* an `AsyncDisposable`:

```ts
await using stmt = sql.prepare('select * from users where id = @id')
  .input('id', types.Int)

// First .bind().terminal() call: runs sp_prepare, pins a connection, caches the handle.
const alice = await stmt.bind({ id: 1 }).all()

// Subsequent calls: reuse the handle via sp_execute on the same pinned connection.
const bob = await stmt.bind({ id: 2 }).all()

// End of `using` scope: sp_unprepare runs, connection returns to the pool.
```

Semantics:

- **First `.bind().terminal()` triggers `sp_prepare`.** The prepared statement is lazy in the same way `Query` is ([ADR-0008](0008-query-lifecycle-and-disposal.md)) — `sql.prepare(text).input(...)` builds the template without touching the server. The server handle is created on the first execution, at which point a connection is acquired and pinned for the rest of the `PreparedStatement`'s lifetime.
- **Subsequent executions use `sp_execute`.** The cached handle stays alive for the whole scope; further `.bind().terminal()` calls reuse it on the pinned connection.
- **`.dispose()` runs `sp_unprepare` and releases the pinned connection.** Uniform with `ReservedConn` disposal ([ADR-0008](0008-query-lifecycle-and-disposal.md)) — the connection goes back to the pool ([ADR-0011](0011-pool-port.md)), the server handle is freed, and any further `.bind()` on the disposed statement throws.
- **Never-bound statements are a no-op at disposal.** If no terminal ever fired, no connection was pinned and no handle was created; `.dispose()` has nothing to do.

`PreparedStatement` extends `Query<T>` symmetrically with `Procedure`. If no `.input()` slots have been declared, the statement is directly awaitable — `await sql.prepare('select 1')` works the same way `await sql.procedure('sp_list_users')` does. If inputs have been declared, the type system requires `.bind({...args})` before any terminal compiles (the runtime would also reject; the types catch it earlier). The interface stays consistent across the two template kinds: declare your inputs, bind your args, await. No-args is no ceremony.

## Consequences

- Stored procedures and prepared statements share one builder surface (`.input()` / `.output()` / `.inout()` / `.bind()`) and both extend `Query` — consumers written against `Query` accept either without change.
- Both are re-executable templates: each terminal call on a bound query is a fresh round-trip, so the same `getUser` template can be fed many argument sets without re-declaring inputs. Raw-tag Queries remain single-consumption ([ADR-0006](0006-queryable-api.md)) — the divergence is intentional and matches the prior art (better-sqlite3 `Statement`, pg prepared handles).
- Output parameters and return status are uniformly available via `q.meta()` ([ADR-0007](0007-query-result-presentation.md)); the procedure builder parameterises `O` from `.output()` / `.inout()` declarations so `(await q.meta()).output.x` is typed without restating at the call site.
- Prepared statements add a **connection-pinned lifecycle** the user opts into: `sp_prepare` on first execute, `sp_execute` on subsequent calls, `sp_unprepare` on dispose. Connection pinning is the cost of the better plan-cache behaviour `sp_prepare` gives — users who do not need that reach for the bare `sql\`\`` tag, which uses parameterised execution without pinning.
- Builder methods are immutable-fluent — each returns a new template — so a configured procedure handle can be shared across callers without one mutating it for another. This matches the immutable-builder patterns in the wider ecosystem (URL, Headers, postgres.js fragments).
- Zero-input templates skip the `.bind({})` ceremony: `await sql.procedure('sp_list_users')` and `await sql.prepare('select 1')` work directly. Templates with declared inputs require `.bind()` before any terminal compiles.

## Alternatives considered

**Tagged template only, no builder for stored procs.** Rejected — procedure output parameters are a distinct return channel that cannot be cleanly expressed through a tag without contorting the result type. The builder surface (`.input()` / `.output()` / `.inout()`) gives the type system somewhere to record output-parameter shapes so `(await q.meta()).output.x` is typed; a tag-only design would either lose that typing or push it into a side-channel that is harder to discover at the call site.

**Use `sp_executesql` instead of `sp_prepare`/`sp_execute` for `sql.prepare()`.** Considered because `sp_executesql` is session-independent: no connection pinning, no explicit release, no disposal lifecycle. Rejected for v13.0. Plan-cache behaviour under `sp_prepare`/`sp_execute` is materially better for parameterised queries with stable text — which is exactly the workload `sql.prepare()` exists to serve — and the connection-pinning lifecycle is the same one `sql.acquire()` already uses, so users and the library pay the cost once. Users who want `sp_executesql`-style parameterisation without the pinning already have it via the bare `sql\`\`` tag.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — parent decision; `Query<T,O>` is the base type these templates extend.
- [ADR-0007: Query result presentation](0007-query-result-presentation.md) — `q.meta()` carries output parameters and return status, typed by the procedure builder.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — `PreparedStatement.dispose()` follows the uniform disposal contract.
- [ADR-0011: Pool port](0011-pool-port.md) — connection pinning and return-on-dispose semantics.
- [better-sqlite3 Statement API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#class-statement) — reference for the builder + bind pattern.
- [pg prepared statements](https://node-postgres.com/features/queries#prepared-statements) — reference for re-executable handle semantics.
