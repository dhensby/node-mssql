import type { EventEmitter } from 'node:events'
import type { MssqlError } from '../errors/index.js'
import type {
	BulkOptions,
	BulkResult,
	ExecuteRequest,
	PrepareRequest,
	PreparedHandle,
	TxOptions,
} from './requests.js'
import type { ResultEvent } from './result-event.js'

export type ConnectionCloseReason = 'user' | 'remote' | 'error' | 'reset'

export interface ConnectionClosePayload {
	readonly reason: ConnectionCloseReason
	readonly error?: MssqlError
}

export interface ConnectionEvents {
	close: [ConnectionClosePayload]
}

export interface Connection extends EventEmitter<ConnectionEvents> {
	readonly id: string
	execute(req: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ResultEvent>
	beginTransaction(opts?: TxOptions): Promise<void>
	commit(): Promise<void>
	rollback(): Promise<void>
	savepoint(name: string): Promise<void>
	releaseSavepoint(name: string): Promise<void>
	rollbackToSavepoint(name: string): Promise<void>
	prepare(req: PrepareRequest): Promise<PreparedHandle>
	bulkLoad(opts: BulkOptions): Promise<BulkResult>
	reset(): Promise<void>
	ping(): Promise<void>
	close(): Promise<void>
}
