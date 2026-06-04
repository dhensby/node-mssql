// A stand-in for the native `Promise.withResolvers()` (stable in Node 22),
// which is unavailable at our Node 20.3 engine floor. It returns a promise
// alongside its `resolve` / `reject`, so a deferred can be settled from
// outside its executor without repeating the
// `let resolve!: …; const p = new Promise((r) => { resolve = r });` dance at
// every call site.
//
// MODERNIZE(node>=22): delete this module and call the native
// `Promise.withResolvers()` instead — the return shape is identical, so the
// migration is import-only.

/**
 * The handle returned by {@link withResolvers}: a pending promise together
 * with the functions that settle it. Mirrors the TS lib's
 * `PromiseWithResolvers<T>` so the eventual swap to the native API is
 * structurally seamless.
 */
export interface PromiseWithResolvers<T> {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
}

/**
 * Create a promise paired with its settle functions, so it can be resolved
 * or rejected from outside the executor (a "deferred").
 *
 * @returns the pending `promise` and the `resolve` / `reject` that settle it.
 */
export function withResolvers<T>(): PromiseWithResolvers<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
