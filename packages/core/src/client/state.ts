/**
 * `ClientState` — the canonical Client state machine (ADR-0018).
 *
 * ```
 * pending  → open       (connect() resolves)
 * pending  → destroyed  (connect() rejects, or close() / destroy() called from pending)
 * open     → draining   (close() called)
 * open     → destroyed  (destroy() called)
 * draining → destroyed  (drain completes naturally, or destroy() called concurrently)
 * ```
 *
 * Extracted to its own file so the `diagnostics/channels.ts` module
 * can reference the type without importing the {@link Client} class
 * (which would create a circular import — `Client` imports from
 * `diagnostics` to publish on its channel).
 */

export type ClientState = 'pending' | 'open' | 'draining' | 'destroyed';
