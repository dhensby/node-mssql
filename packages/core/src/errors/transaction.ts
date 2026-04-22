import { MssqlError } from './base.js'

export class TransactionError extends MssqlError {
	override readonly name: string = 'TransactionError'
}
