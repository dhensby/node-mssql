# ADR-0006: Unified queryable API with cardinality terminals

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

The v12 library exposes four separately-shaped entry points for running SQL: `ConnectionPool`, `Request`, `Transaction`, and `PreparedStatement`. Each behaves differently:

- `Promise.all` works on requests against the pool but not on requests against a `Transaction` or a `PreparedStatement` — users get an `EREQINPROG` runtime error with no compile-time hint.
- Result shapes differ between them — a plain query returns one thing, a stored proc returns another, and the OUTPUT clause of an INSERT lands in yet another field.
- Lifecycle responsibilities are spread across the four types and the user has to remember which to acquire, release, commit, or dispose.

Modern libraries have converged on a better shape:

- `postgres.js` treats a tagged template function as the *entire* queryable — pool, reserved connection, transaction, and savepoint all expose the same callable.
- `better-sqlite3` uses cardinality-named terminal methods (`.get`, `.all`, `.run`, `.iterate`) instead of a single `.query()` whose return shape depends on the SQL text.
- `jose` applies builder patterns for multi-step producers and plain function calls for one-shots.

## Decision

This ADR records the **top-level decision**: one queryable shape, the dual-protocol `Query`, the terminal set, and the scope-factory rules. Result presentation (`.raw()`, `.columns()`, trailer data, side channels), query lifecycle and disposal semantics, and re-executable templates (stored procedures, prepared statements) are large enough to merit their own discussion and are out of scope here.

### One shape across every scope

The `sql` value returned from `createClient` is a tagged-template callable. Pool, reserved connection, transaction, and savepoint are all the same shape — the callable, bound to a scope. `Promise.all` always works; whichever scope is serialised internally (a reserved connection, a transaction) queues parallel callers on the underlying connection so the user never sees a serialisation error.

The tag returns a `Query<T>` object that is **simultaneously** a `PromiseLike<T[]>` and an `AsyncIterable<T>`. Both `await` and `for await` work directly on the tag, and cardinality-named terminals provide explicit alternatives for each consumption mode and for cases the two base protocols do not cover:

```ts
// Awaited — buffered
const rows: User[] = await sql`select * from users`

// Iterated — streamed
for await (const user of sql`select * from users`) { ... }
```

| Terminal | `await` returns | `for await` yields | Notes |
|---|---|---|---|
| *(none)* | `T[]` | `T` | Default = `.all()` / `.iterate()` — single rowset assumed |
| `.all<T>()` | `T[]` | — | Explicit alias for the default `await` behaviour |
| `.iterate<T>()` | — | `T` | Explicit alias for the default `for await` behaviour |
| `.run()` | `QueryMeta<O>` | — | Drains the response *without buffering rows* — memory-efficient for DML or procs whose rowsets you do not need |
| `.raw<R>()` | `R[]` | `R` | Toggle view: rows arrive as `unknown[]` tuples instead of objects. Preserves duplicate columns, matches `.columns()` order; otherwise identical to the Query it was called on |
| `.columns()` | `ColumnMeta[]` | — | Column metadata for the first rowset. Resolves at the first metadata token |
| `.rowsets<Tuple>()` | `Tuple` | `AsyncIterable<Tuple[number]>` | Multi-rowset: buffered tuple when awaited, nested stream when iterated. Each inner rowset carries its own `.columns()` |

### Single-rowset terminals throw on multi-rowset

**Single-rowset *consuming* terminals throw on multi-rowset.** If a query using `.all`, `.iterate`, `.raw`, or the default `await` / `for await` encounters a second rowset boundary, it rejects with `MultipleRowsetsError` pointing at `.rowsets()`. Silent concatenation would lose structure; silent first-rowset-only would lose data; failing loud forces the user to be explicit when a query they expected to be single-rowset isn't.

`MultipleRowsetsError` fires only for terminals that are **actively presenting rows to the caller** across a rowset boundary. Drain-only paths — `.run()` — are deliberately oblivious to rowset boundaries: they are draining the response to clear the request, not promising any shape to the caller, so a second rowset boundary is indistinguishable from a normal row boundary to them. `MultipleRowsetsError` is the concern of *row-shape-promising* terminals only.

`MultipleRowsetsError` is a non-recoverable terminal failure: the promise rejects (or the iterator throws) and the query is done. There is no "catch and continue" path — by the time the error fires, we have already passed at least one rowset boundary, so the single-rowset contract the terminal promised is broken. Users who want to continue processing past the boundary switch terminal to `.rowsets()`. For the async-iterable terminals (default `for await`, `.iterate()`, `.raw()`), catching inside the `for await` loop does not trigger the iterator's `return()` — but by the time control re-enters the loop the generator has thrown, so the iterator is already done; there is no resume. This is an intentional design choice over a recoverable variant: the recovery path would require buffering state across rowset boundaries the single-rowset terminal explicitly does not want to carry.

### Single-consumption for row-consuming terminals

Each `Query<T>` object is single-consumption for row-consuming terminals: once `.all()`, `.iterate()`, `.raw()`, or the default `await` / `for await` has drained the stream (or errored), a second consuming terminal on the same object throws — `await q.all()` followed by `await q.iterate()` throws on the second call. To run the same SQL again, call the tag again — each call produces a new `Query<T>` and a new server round-trip. To run it once and share the materialised rows, `await` it and share the resulting `T[]`. `.columns()` and `.meta()` may be called repeatedly and resolved concurrently with a consuming terminal (e.g. `const [rows, meta] = await Promise.all([q.all(), q.meta()])`) — they observe the same underlying stream without competing for it.

Stored procedures and prepared statements are the deliberate exception to single-consumption: they are *templates*, and each `.bind().terminal()` call produces a fresh internal Query for a fresh round-trip.

### Multi-rowset, buffered or streamed

SQL Server treats multi-statement requests and multi-`SELECT` stored procedures as first-class — multiple result sets land on one request. Rather than splitting this across two terminals, the `.rowsets()` terminal is both thenable and async-iterable (same pattern as `Query` itself at the top level), and the user picks consumption mode by how they consume it:

```ts
// Buffered: await yields a typed tuple
const [users, orders] = await sql`
  select * from users;
  select * from orders
`.rowsets<[User, Order]>()

// Streamed: for await yields one AsyncIterable per rowset, in order
for await (const rowset of sql`
  select * from users;
  select * from orders
`.rowsets<[User, Order]>()) {
  for await (const row of rowset) {
    // row is User on the first outer iteration, Order on the second
    process(row)
  }
  // rowset fully drained — do per-rowset boundary work here
}
```

The streamed shape is `AsyncIterable<AsyncIterable<T>>`. The tuple type parameter narrows each inner iterable — TypeScript sees `User` in the first, `Order` in the second. Row order *within* a rowset is as the server emits it; rowset order is source-SQL order. Breaking out of either loop cancels the request.

This shape has no direct prior art in the SQL-client landscape — Go's `database/sql` uses a pull cursor (`rows.NextResultSet()`), Oracle's node-oracledb uses implicit-result arrays of per-rowset streams, and mssql v12 uses flat `'recordset'`/`'row'` events. Nested async iterables compose better with TypeScript tuple typing and with `for await`, and they avoid the "which rowset is this row from?" state machine that flat events force on consumers.

### Scope factories — extend, don't replace

All scopes return the same callable shape — the only difference is the lifecycle of the underlying connection:

```
sql                           // pool-bound queryable
sql.acquire() -> ReservedConn // AsyncDisposable, same callable shape
sql.transaction(fn | (): tx)  // higher-order or handle form; same callable shape
tx.savepoint(fn | (): sp)     // same callable shape
```

Each layer **extends** the callable rather than replacing it. `sql.acquire()` returns a `ReservedConn` that *is* the callable tag plus an `AsyncDisposable`. `sql.transaction()` returns a `tx` that *is* the callable tag plus `.savepoint()`, `.commit()`, `.rollback()` (when using the handle form; the scoped-callback form manages those for the user). A savepoint likewise adds `.savepoint()` / release / rollback-to on top of the same callable. The same stance applies to procedures and prepared statements — they extend `Query<T>` rather than introducing a parallel hierarchy. Users learn one shape and see it extended at each layer, not replaced.

### Session-scoped state (temp tables, settings)

SQL Server binds certain objects to the session, not the request: `#temp_table` persists across requests on the same connection, `SET LANGUAGE` persists, `DECLARE @var` does not (it is statement-scoped). Under pooling, "the same connection" only holds while a holder owns that connection — once released, another acquirer may pick it up.

Users who rely on session-scoped state (create temp table → query it → drop it) need to pin a connection for the lifetime of the session:

```ts
await using conn = await sql.acquire()
await conn`create table #items (id int)`.run()
await conn`insert into #items (id) select id from source where ...`.run()
const rows = await conn`select * from #items`
// #items is discarded when the connection resets on release
```

`sql.transaction()` and `sql.savepoint()` do the same thing implicitly — both pin one connection for the scope duration — so temp tables are a natural fit inside a transaction.

What breaks (deliberately, to match pool semantics): using a raw `sql` tag (pool-bound) for the *first* statement and then another raw `sql` tag for the *second* is not guaranteed to land on the same connection. The temp table from statement one may not exist for statement two. There is no library-level magic to make this work; the user pins the connection with `acquire` / `transaction`, or they accept that each tag call can land anywhere. This is the same trade-off every pooled DB client makes; the escape hatch (`sql.acquire()`) is small and explicit.

The connection's default reset-on-release (`Connection.reset()` → `sp_reset_connection`, called by the pool adapter inside its release path) clears session-scoped temp tables automatically, so leaked `#items` tables do not accumulate across acquirers.

## Consequences

- Learning the API is learning one callable, a handful of terminals, and `.meta()` for trailer data. Every scope works the same way.
- `Promise.all` always works. `EREQINPROG` is never surfaced; scopes that own a single underlying connection queue callers internally.
- Consumers no longer carry context about "what kind of thing is this" — a function taking `sql: Queryable` can be called with the pool, a reserved connection, a transaction, or a savepoint with identical behaviour.
- Result shapes are chosen at the call site by the terminal, not inferred from the SQL text. The long-standing "is my result in `.recordset` or `.output`?" confusion (issue #1562) goes away.
- The tagged-template form makes it impossible to forget parameterisation at the type level. `sql\`select * from t where id = ${id}\`` always binds `id` as a parameter, never interpolates.
- Raw string SQL (from query builders) is still supported via an explicit escape hatch, `sql.unsafe(text, params)`. The name signals intent.
- Each scope-factory extension (`sql.acquire()`, `sql.transaction()`, `sql.savepoint()`, and the procedure / prepared-statement templates) adds its scope-specific methods on top of the same callable tag shape — users learn one shape and see it extended at each layer, not replaced.
- Session-scoped state (temp tables, `SET` settings) works the way it does in every pooled SQL client: safe inside `sql.acquire()` / `sql.transaction()` / `sql.savepoint()`, not safe across bare pool-bound `sql` calls. The library does not try to hide this, and the default `sp_reset_connection` on release cleans up.

## Alternatives considered

**Keep v12's four separate types, with better types.** Rejected — the parallel-request limitation is a genuine ergonomic failure that strict typing does not solve.

**A monolithic `.query()` returning a fat object.** Rejected — better-sqlite3 proves cardinality-named terminals are clearer and produce better types.

**Thenable OR async-iterable, not both — pick one and put the other on a terminal.** Considered for the clarity it brings: a `Query` object that is *only* awaitable, with iteration on `.iterate()` (or vice versa), makes the consumption mode unambiguous at the type level. Rejected because both `await sql\`...\`` and `for await (... of sql\`...\`)` are the most natural, lowest-ceremony forms a user reaches for, and the underlying transport supports both cheaply from the same `Query` object — we just pick which protocol the terminal drives. Re-consumption is handled by making every `Query<T>` single-consumption for row terminals (second `await` or second `for await` on the same object throws), not by amputating one of the two idioms. Explicit `.all()` / `.iterate()` terminals remain as readable aliases and for the cardinalities the two base protocols do not cover (`.run()`, `.raw()`, `.rowsets()`).

**Ship `.one()` / `.get()` / `.result()` as v13.0 terminals.** Considered — every major client ships at least one of them. Deferred to v13.1+ as non-breaking additions. `.one()` is a thin wrapper around `(await q.all())[0] ?? null`; the inline form is one line and makes the "or what on empty?" question explicit at the call site rather than buried in terminal semantics. `.result()` bundles rows + meta in one shape, but `const [rows, meta] = await Promise.all([q.all(), q.meta()])` composes those two already-available terminals and keeps the mental model smaller. Better-sqlite3's `.expand()` for joined-row namespacing is a separate future consideration, also v13.1+. v13.0 commits to the minimum terminal set that covers the cardinalities the two base protocols do not (`.run()`, `.raw()`, `.rowsets()`) plus the shape-introspection pair (`.columns()`, `.meta()`); everything else is additive.

**`.clone()` to permit re-consumption, mirroring `fetch`'s `Response.clone()`.** Considered because the pattern is familiar from HTTP. Rejected — the analogy breaks down. `Response.clone()` works by tee-ing the underlying byte stream so two consumers can read the same body without the server being asked twice; the library pays the cost in memory. For SQL, the server has already started sending rows by the time you have a `Query`, but each row is a *decoded* JS object with its own allocations, type coercions, and column-name bindings. A clone that replays rows is a materialisation regardless — it is `await query; return [rows, rows]`, just with the materialisation hidden inside `.clone()`. We would rather users write `const rows = await sql\`...\`` explicitly when they want to share results, than offer an API that looks like cheap tee-ing but is actually full buffering. Users who want to re-execute the SQL call the tag again; users who want to share rows `await` once and share the `T[]`.

## References

- [postgres.js README](https://github.com/porsager/postgres#queries) — reference for the unified tagged-template pattern.
- [better-sqlite3 Statement API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#class-statement) — reference for cardinality-named terminals.
- [tediousjs/node-mssql#1562](https://github.com/tediousjs/node-mssql/issues/1562) — the output-in-recordset bug.
- [tediousjs/node-mssql#1568](https://github.com/tediousjs/node-mssql/issues/1568) — misuse of template literals.
- [ADR-0001: Scope and goals of the v13 rewrite](0001-scope-and-goals.md)
