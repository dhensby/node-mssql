import { MssqlError, type MssqlErrorOptions } from './base.js';
import type { PoolClosedState } from './pool.js';

export interface ClientClosedErrorOptions extends MssqlErrorOptions {
	state: PoolClosedState
}

export class ClientClosedError extends MssqlError {
	override readonly name: string = 'ClientClosedError';
	readonly state: PoolClosedState;

	constructor(message: string, options: ClientClosedErrorOptions) {
		super(message, options);
		this.state = options.state;
	}
}

// Thrown when a query terminal fires against a client that has not yet
// resolved `client.connect()`. Surfaces via the standard Promise
// rejection chain on the terminal (or the iterator's first `next()` for
// `for await`); not a sync throw at the call site (ADR-0018).
export class ClientNotConnectedError extends MssqlError {
	override readonly name: string = 'ClientNotConnectedError';

	constructor(message = 'client is not connected', options?: MssqlErrorOptions) {
		super(message, options);
	}
}
