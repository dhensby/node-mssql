# ADR-0024: Lifecycle state machines and idempotent async settlement

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** @dhensby

## Context

The kernel is full of objects with a lifecycle: the client, the pool, transactions, savepoints, reserved connections, driver connections, and queries. Almost all of them need the same two things:

1. **A small state machine** — a handful of states (open / draining / destroyed, active / settled, and so on) with rules about which transitions are legal and which calls are allowed in which state.
2. **Idempotent async settlement** — a `close` / `destroy` / `drain` / `dispose` / `release` / `commit` / `rollback` that may be called more than once, concurrently or later, and must behave coherently every time.

Both are shared requirements, but each is easy to satisfy ad hoc, in isolation, at every site that needs it. Left unmanaged that produces the classic DRY failure: the same finite-state-machine shape re-implemented in slightly different ways across many classes, the same "run-this-once" promise plumbing copied with subtle variations, and — because the variations are subtle — genuine bugs that appear in one implementation and not its siblings. Two failure modes are worth calling out because they are easy to get wrong independently:

- **State modelling drifts.** One object models its lifecycle as named states with guarded transitions; another tracks the same kind of lifecycle as a loose set of booleans. There is no shared answer to even "what states should an object have?", so each author re-decides.
- **Idempotency semantics drift.** One settle operation holds a single promise and hands it to every caller; another sets a boolean and returns immediately, which lets a second concurrent caller observe "done" while the first call's work is still in flight. The second is a latent correctness bug (premature completion → teardown-ordering hazards), and nothing stops a new class from reaching for it.

This ADR establishes one approach to both, applied consistently across every lifecycle object, so the shared requirement has a single implementation rather than N divergent ones.

## Decision

Two shared utilities and one design discipline.

### 1. Lifecycle states are coarse *gating* states

A state earns a slot in the enum **only if it gates behaviour differently** — i.e. only if some method behaves differently, or some call is allowed/rejected, depending on it. States that would gate identically to an existing state are not modelled; they are observation-only noise. The information such a sub-state would carry belongs elsewhere:

- **"Is the async transition's work finished?"** → the held settle promise (§4), not a state. A terminal state means *the gate is closed*; the promise resolving means *the work has physically completed*. These are different questions.
- **Why** a transition happened → the transition's event / diagnostics payload, not a state.
- **How long** a transition took → the `tracingChannel` start/asyncEnd ([ADR-0014](0014-diagnostics.md)), not a state.

Concretely, a shutting-down object distinguishes "shutting down, finishing in-flight work, rejecting new work" from "fully torn down" only if those gate differently (they do — one accepts in-flight completions, the other rejects everything); it does **not** add a separate "currently-connecting" state if connecting gates identically to "not yet open", nor a separate "fully-drained" state if it gates identically to "destroyed".

### 2. State is the logical gate, set synchronously at the gate-change point

The state mutates the instant the *gate* should change, not when the underlying async work completes:

- **Eager on shutdown.** A shutdown verb flips the state to its draining/terminal gate **synchronously**, before the async teardown runs. This is a correctness requirement: a request arriving the moment shutdown begins must be gated, not slip through while teardown is in flight.
- **On-success on startup.** A startup verb flips to the serveable gate only **after** the resource is actually ready. An object must never advertise a serveable state before it can serve.

The asymmetry (shutdown eager, startup on-success) follows from a single rule — flip the gate when it is *safe* to flip — which differs between opening and closing.

### 3. A shared state-machine helper

State, transition legality, and same-state no-op detection move into one small helper:

```ts
createStateMachine<S extends string>({
  initial,
  transitions,                 // directed graph (need NOT be linear): { open: ['draining','destroyed'], … }
  onTransition?(from, to),     // side-effect seam: emit an event, publish a diagnostics channel
}): {
  readonly state: S
  is(...s: S[]): boolean
  can(to: S): boolean          // is current → to a legal transition?
  to(next: S): boolean         // perform it; same-state is a no-op (returns false)
}
```

The helper owns the state field, the transition table, and same-state detection. It **does not throw domain errors** — error production stays with the owning class:

- **`can(to)`** answers legality; the class gates on it and throws *its own* taxonomy error ([ADR-0017](0017-error-taxonomy.md)) from *its own* method, so the error originates — and the stack trace points — at the call site that misused the object, not at the helper.
- **`onTransition(from, to)`** is the single seam for transition side-effects: lifecycle events and diagnostics-channel publishes. Centralising it here means a transition can't be made without its observers firing, and lifecycle diagnostics are emitted in one place rather than scattered through every lifecycle method.
- **`to(next)`** performs a legal transition (running `onTransition`) and treats a same-state transition as a no-op. A genuinely *illegal* transition (one absent from the table) indicates a bug in the owning class's own logic — which a `can`-gated class never triggers — and is the one place the helper **throws, loudly**: a neutral assertion (`illegal transition X → Y`) that is categorically distinct from the user-facing domain errors the class raises via `can`. Reaching it means the *library* has a bug in its own transition logic, not that the caller misused the API, so the assertion message says exactly that and points the reader at filing an issue. It must fail noisily rather than silently corrupt state.

The transition table is a directed graph, **not assumed linear**, so branchy lifecycles are modelled directly (see §5).

### 4. Idempotent async operations hold and share one promise

A "settle once" async operation runs at most once; every caller — concurrent or later — receives the *same* promise:

```ts
function onceAsync<T>(op: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined
  return () => (p ??= op())
}
```

A second caller therefore never observes "done" before the work has settled — flag-then-return-immediately is disallowed. Caching the rejection is deliberate: a failed settle is terminal, not retried (recovery is "construct a new object", per [ADR-0018](0018-client-lifecycle.md)), so re-callers see the same failure rather than re-running the operation.

### 5. State and the held promise are orthogonal, and compose

The state machine answers **"which gate am I in?"**; the held promise answers **"has the transition's async work settled?"** They are distinct axes and must not be folded into one enum — folding them is exactly what tempts an observation-only "in-flight" state into existence (§1).

They compose rather than collide:

- State *flags* are not eliminated — a flag answers a query ("am I disposed?"), and is set *inside* the once-op. The state machine answers "which gate"; the held promise answers "settled?"; a flag answers "have we passed point X?".
- State-*dependent* idempotency is the held promise **gated by** the state machine: a verb whose behaviour differs by state (in-flight → return the same promise; already-open → no-op; closed → reject) is `onceAsync` wrapped in a `can`/`is` check, not pure `onceAsync`.

**Non-linear lifecycles are still state machines.** An object whose states branch (a terminal like *disposed* / *cancelled* reachable from several states; a state reachable by more than one path) is still a single-current-state machine — just with a non-linear transition graph, which §3's table expresses directly. The fact that, say, an object can be disposed without having first been consumed does not defeat the model; it is one more edge. What does *not* belong in the lifecycle state is genuinely concurrent *mechanism* — e.g. a result stream's internal buffering and shape-introspection running alongside row delivery. That coordination lives *below* the lifecycle as its own concern (separated from the public handle), not as a competing state dimension. The most elaborate lifecycle objects are modelled this way: a clean (possibly non-linear) gating machine on top, the messy concurrent mechanism factored out beneath it.

## Consequences

- **One discipline, applied consistently.** Lifecycle objects stop re-deriving FSM machinery and idempotency plumbing; new objects inherit the pattern instead of re-inventing it.
- **A latent bug class is closed.** Hold-and-share makes every caller wait for the real settlement; no caller observes premature completion, and the teardown-ordering hazards that follow from it cannot arise.
- **Errors originate where they belong.** Because the helper never throws domain errors — the class gates on `can` and throws its own — stack traces point at the misusing call site, not at shared infrastructure.
- **Diagnostics get a single seam.** `onTransition` is where lifecycle channels publish, rather than scattering publishes through lifecycle methods; a transition cannot happen without its observers firing.
- **The state enum stays small and honest.** Each state gates differently; readers reason about a handful of gates, not a parade of transient sub-states. The accepted cost is that "is the teardown physically done?" is answered by awaiting the settle promise, not by reading the state — which is the correct separation of the two axes, not a workaround.
- **Composition, not inheritance.** The two utilities are supplied independently, which keeps the orthogonality of state-vs-settlement intact and avoids coupling them into a base class — important because several lifecycle objects are *callables* (tagged-template scopes) that a class hierarchy models poorly. Polymorphism, where wanted, comes from shared interfaces, not a shared base.

## Alternatives considered

**Fine-grained transition states (a distinct state for each in-flight phase).** Rejected. A state that gates identically to an existing one is observation-only; the in-flight signal belongs on the held promise, the reason on the event payload, the timing on the tracingChannel. Modelling transient phases as states inflates the enum and the transition surface without changing any decision the object makes.

**Flag-then-return-immediately idempotency.** Rejected. A boolean flag with an early return lets a second concurrent caller proceed as if the operation finished while the first caller's work is still in flight; teardown-ordering bugs follow directly. Hold-and-share is the fix.

**Per-class hand-rolled state and settlement.** Rejected — this is the DRY failure the ADR exists to prevent. The per-class guards and promise-plumbing are nearly identical; centralising them removes duplication and the opportunity to get one variant subtly wrong.

**The state machine throws domain errors (an `onInvalid` hook supplying the class's error class).** Considered. Rejected because the throw then originates inside the shared helper: the stack trace's top frame is the state machine, not the `Pool` / `Client` / `Transaction` method the caller actually misused, which is misleading exactly when someone is debugging. Having the class gate on `can` and throw its own error keeps error origin where it belongs. The helper may still throw a *neutral* assertion for a genuinely illegal transition, but that is a developer bug-guard, not a domain error.

**A single lifecycle base class via inheritance.** Rejected. Several lifecycle objects are callables (tagged-template scopes); `class extends Function` models "a callable with methods" badly, and inheritance would couple the state machine and the settle-promise into one base when they are orthogonal axes best supplied independently. Structural-interface polymorphism already provides the polymorphism; the gap was construction-time reuse, which composable utilities serve better than a base class.

**A `reason` field on the state rather than the event payload.** Considered (it mirrors the tracingChannel `asyncEnd` `reason`). Rejected for the state enum — the reason a transition happened is metadata about the *edge*, not a *gate*; it rides the transition's event payload and the diagnostics channel, where consumers already look for it.

## References

- [ADR-0006: Unified queryable API](0006-queryable-api.md) — transaction / savepoint / query scopes and their lifecycles.
- [ADR-0008: Query lifecycle and disposal](0008-query-lifecycle-and-disposal.md) — disposal semantics and the cancel-then-settle ordering the held promise protects; the separation of a query's lifecycle from its stream mechanism.
- [ADR-0011: Pool port](0011-pool-port.md) — pool lifecycle.
- [ADR-0014: Diagnostics](0014-diagnostics.md) — the `onTransition` hook is the lifecycle-channel emit seam; transition timing rides the tracingChannel.
- [ADR-0016: Object ID format](0016-object-id-format.md) — ids carried on lifecycle events/channels.
- [ADR-0017: Error taxonomy](0017-error-taxonomy.md) — `can`-gated classes throw their own domain errors (`ClientClosedError`, `PoolClosedError`, and the state-misuse class).
- [ADR-0018: Client lifecycle](0018-client-lifecycle.md) — the canonical worked example of these states; "retry by constructing a new object" is why the held promise caches rejections.
