import { MssqlError, type MssqlErrorOptions } from './base.js';

export interface QueryErrorOptions extends MssqlErrorOptions {
	number: number
	state: number
	severity: number
	serverName?: string
	procName?: string
	lineNumber?: number
}

export class QueryError extends MssqlError {
	override readonly name: string = 'QueryError';
	readonly number: number;
	readonly state: number;
	readonly severity: number;
	readonly serverName?: string;
	readonly procName?: string;
	readonly lineNumber?: number;

	constructor(message: string, options: QueryErrorOptions) {
		super(message, options);
		this.number = options.number;
		this.state = options.state;
		this.severity = options.severity;
		if (options.serverName !== undefined) this.serverName = options.serverName;
		if (options.procName !== undefined) this.procName = options.procName;
		if (options.lineNumber !== undefined) this.lineNumber = options.lineNumber;
	}
}

export type ConstraintKind = 'unique' | 'foreignKey' | 'check' | 'notNull' | 'default';

export interface ConstraintErrorOptions extends QueryErrorOptions {
	kind: ConstraintKind
	constraintName?: string
}

export class ConstraintError extends QueryError {
	override readonly name: string = 'ConstraintError';
	readonly kind: ConstraintKind;
	readonly constraintName?: string;

	constructor(message: string, options: ConstraintErrorOptions) {
		super(message, options);
		this.kind = options.kind;
		if (options.constraintName !== undefined) this.constraintName = options.constraintName;
	}
}

// Map a T-SQL error number to a constraint kind.
// 547 is overloaded (FK and CHECK); a caller with the message text can
// pass it as messageHint to disambiguate.
export function constraintKindFromNumber(
	number: number,
	messageHint?: string,
): ConstraintKind | undefined {
	switch (number) {
		case 2627:
		case 2601:
			return 'unique';
		case 547:
			if (messageHint !== undefined && messageHint.includes('CHECK constraint')) return 'check';
			return 'foreignKey';
		case 515:
			return 'notNull';
		case 544:
		case 8114:
			return 'default';
		default:
			return undefined;
	}
}

export class MultipleRowsetsError extends MssqlError {
	override readonly name: string = 'MultipleRowsetsError';
}
