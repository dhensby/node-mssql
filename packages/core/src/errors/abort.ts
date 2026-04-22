import { MssqlError, type MssqlErrorOptions } from './base.js'

export class AbortError extends MssqlError {
	override readonly name: string = 'AbortError'
}

export class TimeoutError extends MssqlError {
	override readonly name: string = 'TimeoutError'
}

// Pick the right class from an aborted signal's reason, preserving the
// original reason on `.cause`. `AbortSignal.timeout()` produces a
// DOMException with `name: 'TimeoutError'`; bare `controller.abort()`
// defaults to `name: 'AbortError'`; a consumer-supplied reason passes
// through unchanged on `.cause` but falls into the AbortError bucket
// unless it also names itself 'TimeoutError'.
export function abortErrorFromSignal(
	signal: AbortSignal,
	options?: Omit<MssqlErrorOptions, 'cause'>,
): AbortError | TimeoutError {
	const reason: unknown = signal.reason
	const hasTimeoutName =
		reason !== null &&
		typeof reason === 'object' &&
		'name' in reason &&
		(reason as { name?: unknown }).name === 'TimeoutError'
	const message =
		reason instanceof Error && reason.message.length > 0
			? reason.message
			: hasTimeoutName
				? 'operation timed out'
				: 'operation aborted'
	const Ctor = hasTimeoutName ? TimeoutError : AbortError
	return new Ctor(message, { ...options, cause: reason })
}
