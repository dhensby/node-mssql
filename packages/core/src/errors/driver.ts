import { MssqlError } from './base.js';

export class DriverError extends MssqlError {
	override readonly name: string = 'DriverError';
}
