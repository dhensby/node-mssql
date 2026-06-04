// Idempotent async settlement (ADR-0024 §4): wrap a "settle once" operation
// so it runs at most once and every caller — concurrent or later — receives
// the SAME promise. A second caller therefore never observes "done" before
// the work has actually settled, which the flag-then-return-immediately
// idiom gets wrong (it lets a racing caller proceed as if finished while the
// first call's teardown is still in flight — a latent ordering hazard).
//
// The rejection is cached deliberately: a failed settle is terminal, not
// retried — recovery is "construct a new object" (ADR-0018) — so re-callers
// see the same failure rather than silently re-running the operation.

/**
 * Memoise a settle-once async operation. The returned function runs `op` on
 * its first call and hands that same promise — whether it resolves or
 * rejects — to every later or concurrent caller.
 *
 * @param op the operation to run at most once.
 * @returns a function that returns the shared, memoised promise.
 */
export function onceAsync<T>(op: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return (): Promise<T> => {
		promise ??= op();
		return promise;
	};
}
