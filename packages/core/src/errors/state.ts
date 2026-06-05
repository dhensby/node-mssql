import { MssqlError, type MssqlErrorOptions } from './base.js';

/**
 * Thrown when an operation is attempted that the target's current lifecycle
 * state does not allow — e.g. a tag or lifecycle call on a settled
 * transaction, a terminal on a disposed Query, a query on a released reserved
 * connection, or configuring a transaction builder after it has started.
 *
 * This is a programming error (a bug in the calling code), not a recoverable
 * runtime condition: the fix is to not make the call in that state, so it is
 * not meant to be caught and retried. It extends {@link MssqlError} (rather
 * than being a bare `TypeError`) so it sits in the library's own taxonomy and
 * carries the standard correlation ids.
 */
export class StateError extends MssqlError {
	override readonly name: string = 'StateError';

	constructor(message: string, options?: MssqlErrorOptions) {
		super(message, options);
	}
}
