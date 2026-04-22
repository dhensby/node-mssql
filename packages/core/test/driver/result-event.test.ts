import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResultEvent } from '../../src/driver/index.js'

test('ResultEvent — discriminates on kind across all nine shapes', () => {
	const events: ResultEvent[] = [
		{ kind: 'metadata', columns: [{ name: 'id', nullable: false }] },
		{ kind: 'row', values: [1, 'a'] },
		{ kind: 'rowsetEnd', rowsAffected: 1 },
		{ kind: 'output', name: 'assigned', value: 'x' },
		{ kind: 'returnValue', value: 0 },
		{
			kind: 'info',
			number: 50000,
			state: 1,
			class: 10,
			message: 'info',
			serverName: 'srv',
			procName: 'sp',
			lineNumber: 1,
		},
		{ kind: 'print', message: 'hello' },
		{ kind: 'envChange', type: 'database', oldValue: 'master', newValue: 'app' },
		{ kind: 'done' },
	]
	const kinds = events.map((e) => e.kind)
	assert.deepEqual(
		new Set(kinds),
		new Set([
			'metadata',
			'row',
			'rowsetEnd',
			'output',
			'returnValue',
			'info',
			'print',
			'envChange',
			'done',
		]),
	)
	for (const e of events) {
		switch (e.kind) {
			case 'row':
				assert.deepEqual(e.values, [1, 'a'])
				break
			case 'metadata':
				assert.equal(e.columns[0]?.name, 'id')
				break
			case 'envChange':
				assert.equal(e.type, 'database')
				break
			// exhaustiveness: all other kinds have been constructed above
		}
	}
})
