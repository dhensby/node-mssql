import { MssqlError, type MssqlErrorOptions } from './base.js'
import type { PoolClosedState } from './pool.js'

export interface ClientClosedErrorOptions extends MssqlErrorOptions {
	state: PoolClosedState
}

export class ClientClosedError extends MssqlError {
	override readonly name: string = 'ClientClosedError'
	readonly state: PoolClosedState

	constructor(message: string, options: ClientClosedErrorOptions) {
		super(message, options)
		this.state = options.state
	}
}
