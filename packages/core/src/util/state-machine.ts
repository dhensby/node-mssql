// Shared lifecycle state machine (ADR-0024 §3). It owns the current state,
// a directed (NOT necessarily linear) transition table, and same-state
// no-op detection — the machinery every lifecycle object would otherwise
// re-derive.
//
// It deliberately does NOT throw domain errors. The owning class gates on
// `can()` and throws its OWN taxonomy error from its own method, so the
// stack trace points at the call site that misused the object, not at this
// helper. The single thing it throws is a loud, neutral assertion for a
// transition absent from the table — which can only mean the library's own
// lifecycle logic has a bug, never a caller mistake.

export interface StateMachine<S extends string> {
	/** The current state. */
	readonly state: S
	/** Whether the current state is one of `states`. */
	is(...states: S[]): boolean
	/**
	 * Whether {@link StateMachine.to} would be allowed for `target`: `true`
	 * for a declared transition OR a same-state no-op; `false` only for a
	 * target absent from the table (which `to()` rejects as a library bug).
	 */
	can(target: S): boolean
	/**
	 * Move to `target`. A same-state call is a no-op and returns `false`; a
	 * declared transition mutates the state, runs `onTransition`, and returns
	 * `true`. A target absent from the table throws — that can only be a
	 * library bug.
	 */
	to(target: S): boolean
}

export interface StateMachineOptions<S extends string> {
	/** The starting state. */
	initial: S
	/**
	 * Directed transition graph — for each state, the states it may move to.
	 * Must list every state (terminals map to an empty array). Need not be
	 * linear: branchy lifecycles (a terminal reachable from several states)
	 * are expressed directly.
	 */
	transitions: Record<S, readonly S[]>
	/**
	 * Side-effect seam, run AFTER `state` mutates on a real (non-no-op)
	 * transition — the one place to emit lifecycle events and publish
	 * diagnostics, so a transition cannot occur without its observers firing.
	 * Observers already see the new `state`.
	 */
	onTransition?: (from: S, to: S) => void
}

/**
 * Create a {@link StateMachine}. State and the held settle promise are
 * orthogonal axes (ADR-0024 §5): this owns "which gate am I in?", not "has
 * the async work settled?".
 */
export function createStateMachine<S extends string>(
	options: StateMachineOptions<S>,
): StateMachine<S> {
	const { initial, transitions, onTransition } = options;
	let state = initial;

	return {
		get state(): S {
			return state;
		},
		is(...states: S[]): boolean {
			return states.includes(state);
		},
		can(target: S): boolean {
			return target === state || transitions[state].includes(target);
		},
		to(target: S): boolean {
			if (target === state) return false;
			if (!transitions[state].includes(target)) {
				throw new Error(
					`illegal state transition: ${state} → ${target}. This is a bug in the library's own lifecycle logic, not a misuse of the public API — please report it at https://github.com/tediousjs/node-mssql/issues`,
				);
			}
			const from = state;
			state = target;
			onTransition?.(from, target);
			return true;
		},
	};
}
