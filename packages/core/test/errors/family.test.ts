import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../../src/index.js'
import * as errors from '../../src/errors/index.js'
import {
	AbortError,
	ClientClosedError,
	ConnectionError,
	ConstraintError,
	CredentialError,
	DriverError,
	MssqlError,
	MultipleRowsetsError,
	PoolAcquireTimeoutError,
	PoolClosedError,
	PoolError,
	QueryError,
	TimeoutError,
	TransactionError,
} from '../../src/errors/index.js'

test('every library-produced error extends MssqlError', () => {
	const samples: Error[] = [
		new ConnectionError('x'),
		new CredentialError('x'),
		new QueryError('x', { number: 1, state: 1, severity: 1 }),
		new ConstraintError('x', { number: 2627, state: 1, severity: 14, kind: 'unique' }),
		new MultipleRowsetsError('x'),
		new TransactionError('x'),
		new PoolError('x'),
		new PoolClosedError('x', { state: 'draining' }),
		new PoolAcquireTimeoutError('x'),
		new ClientClosedError('x', { state: 'destroyed' }),
		new AbortError('x'),
		new TimeoutError('x'),
		new DriverError('x'),
	]
	for (const err of samples) {
		assert.ok(err instanceof MssqlError, `${err.constructor.name} must extend MssqlError`)
	}
})

test('main entry re-exports the error classes', () => {
	assert.equal(core.MssqlError, errors.MssqlError)
	assert.equal(core.ConstraintError, errors.ConstraintError)
	assert.equal(core.AbortError, errors.AbortError)
})
