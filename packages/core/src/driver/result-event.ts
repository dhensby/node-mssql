export interface ColumnMetadata {
	readonly name: string
	readonly nullable?: boolean
}

export type EnvChangeType =
	| 'database'
	| 'language'
	| 'charset'
	| 'packetSize'
	| 'collation'
	| 'isolationLevel'
	| 'beginTransaction'
	| 'commitTransaction'
	| 'rollbackTransaction'
	| 'resetConnection'
	| 'routing'

export type ResultEvent =
	| { kind: 'metadata'; columns: ColumnMetadata[] }
	| { kind: 'row'; values: unknown[] }
	| { kind: 'rowsetEnd'; rowsAffected: number }
	| { kind: 'output'; name: string; value: unknown }
	| { kind: 'returnValue'; value: number }
	| {
			kind: 'info'
			number: number
			state: number
			class: number
			message: string
			serverName?: string
			procName?: string
			lineNumber?: number
	  }
	| { kind: 'print'; message: string }
	| { kind: 'envChange'; type: EnvChangeType; oldValue: string; newValue: string }
	| { kind: 'done' }
