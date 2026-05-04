import { MssqlError, type MssqlErrorOptions } from './base.js';

export class PoolError extends MssqlError {
	override readonly name: string = 'PoolError';
}

export type PoolClosedState = 'draining' | 'destroyed';

export interface PoolClosedErrorOptions extends MssqlErrorOptions {
	state: PoolClosedState
}

export class PoolClosedError extends PoolError {
	override readonly name: string = 'PoolClosedError';
	readonly state: PoolClosedState;

	constructor(message: string, options: PoolClosedErrorOptions) {
		super(message, options);
		this.state = options.state;
	}
}

// No `PoolAcquireTimeoutError`: pool contention manifests as `TimeoutError`
// (or `AbortError`) with `phase: 'pool-acquire'`, the uniform signal/phase
// model rather than a special class. See ADR-0017 alternatives considered.
