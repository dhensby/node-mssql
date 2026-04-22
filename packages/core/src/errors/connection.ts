import { MssqlError } from './base.js'

export class ConnectionError extends MssqlError {
	override readonly name: string = 'ConnectionError'
}

export class CredentialError extends ConnectionError {
	override readonly name: string = 'CredentialError'
}
