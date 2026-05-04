export interface MssqlErrorOptions extends ErrorOptions {
	connectionId?: string
	queryId?: string
	poolId?: string
}

export class MssqlError extends Error {
	override readonly name: string = 'MssqlError';
	readonly connectionId?: string;
	readonly queryId?: string;
	readonly poolId?: string;

	constructor(message: string, options?: MssqlErrorOptions) {
		super(message, options);
		if (options?.connectionId !== undefined) this.connectionId = options.connectionId;
		if (options?.queryId !== undefined) this.queryId = options.queryId;
		if (options?.poolId !== undefined) this.poolId = options.poolId;
	}
}
