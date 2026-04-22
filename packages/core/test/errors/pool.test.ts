import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	MssqlError,
	PoolAcquireTimeoutError,
	PoolClosedError,
	PoolError,
} from '../../src/errors/index.js'

test('PoolError — extends MssqlError', () => {
	const err = new PoolError('pool exploded')
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof PoolError)
	assert.equal(err.name, 'PoolError')
})

test('PoolClosedError — carries state', () => {
	const err = new PoolClosedError('draining', { state: 'draining' })
	assert.ok(err instanceof PoolError)
	assert.ok(err instanceof PoolClosedError)
	assert.equal(err.name, 'PoolClosedError')
	assert.equal(err.state, 'draining')
})

test('PoolAcquireTimeoutError — name is "TimeoutError" for duck-typing', () => {
	const err = new PoolAcquireTimeoutError('acquire timed out')
	assert.ok(err instanceof PoolError)
	assert.ok(err instanceof PoolAcquireTimeoutError)
	assert.equal(err.name, 'TimeoutError')
})
