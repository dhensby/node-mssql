import { MssqlError, type MssqlErrorOptions } from './base.js';

// Where in the request lifecycle an abort fired. Stamped on every
// `AbortError` / `TimeoutError` so retry policy and debugging can
// distinguish "pool was saturated" from "server may have started
// executing" without inspecting `.message` strings (ADR-0017).
export type AbortPhase =
	| 'pool-acquire'
	| 'connect'
	| 'dispatch'
	| 'response'
	| 'transaction-begin'
	| 'transaction-commit'
	| 'transaction-rollback'
	| 'savepoint'
	| 'rollback-to-savepoint'
	| 'prepare'
	| 'unprepare';

export interface AbortErrorOptions extends MssqlErrorOptions {
	phase: AbortPhase
}

export class AbortError extends MssqlError {
	override readonly name: string = 'AbortError';
	readonly phase: AbortPhase;

	constructor(message: string, options: AbortErrorOptions) {
		super(message, options);
		this.phase = options.phase;
	}
}

export class TimeoutError extends MssqlError {
	override readonly name: string = 'TimeoutError';
	readonly phase: AbortPhase;

	constructor(message: string, options: AbortErrorOptions) {
		super(message, options);
		this.phase = options.phase;
	}
}

// Pick the right class from an aborted signal's reason, preserving the
// original reason on `.cause`. `AbortSignal.timeout()` produces a
// DOMException with `name: 'TimeoutError'`; bare `controller.abort()`
// defaults to `name: 'AbortError'`; a consumer-supplied reason passes
// through unchanged on `.cause` but falls into the AbortError bucket
// unless it also names itself 'TimeoutError'.
export function abortErrorFromSignal(
	signal: AbortSignal,
	options: Omit<AbortErrorOptions, 'cause'>,
): AbortError | TimeoutError {
	const reason: unknown = signal.reason;
	const hasTimeoutName =
		reason !== null &&
		typeof reason === 'object' &&
		'name' in reason &&
		(reason as { name?: unknown }).name === 'TimeoutError';
	const message =
		reason instanceof Error && reason.message.length > 0
			? reason.message
			: hasTimeoutName
				? 'operation timed out'
				: 'operation aborted';
	const Ctor = hasTimeoutName ? TimeoutError : AbortError;
	return new Ctor(message, { ...options, cause: reason });
}
