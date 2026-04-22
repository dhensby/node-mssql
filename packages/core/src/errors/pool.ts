import { MssqlError, type MssqlErrorOptions } from './base.js'

export class PoolError extends MssqlError {
	override readonly name: string = 'PoolError'
}

export type PoolClosedState = 'draining' | 'destroyed'

export interface PoolClosedErrorOptions extends MssqlErrorOptions {
	state: PoolClosedState
}

export class PoolClosedError extends PoolError {
	override readonly name: string = 'PoolClosedError'
	readonly state: PoolClosedState

	constructor(message: string, options: PoolClosedErrorOptions) {
		super(message, options)
		this.state = options.state
	}
}

// Name is 'TimeoutError' so ecosystem code doing `err.name === 'TimeoutError'`
// (fetch / undici / AbortSignal.timeout() convention) matches it, while
// `instanceof PoolAcquireTimeoutError` distinguishes pool contention from
// other timeout sources.
export class PoolAcquireTimeoutError extends PoolError {
	override readonly name: string = 'TimeoutError'
}
