import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	ClientClosedError,
	MssqlError,
	PoolClosedError,
} from '../../src/errors/index.js'

test('ClientClosedError — extends MssqlError, not PoolError', () => {
	const err = new ClientClosedError('client closed', { state: 'destroyed' })
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof ClientClosedError)
	assert.equal(err.name, 'ClientClosedError')
	assert.equal(err.state, 'destroyed')
})

test('ClientClosedError — preserves PoolClosedError on .cause', () => {
	const inner = new PoolClosedError('draining', { state: 'draining' })
	const err = new ClientClosedError('client closed', { state: 'draining', cause: inner })
	assert.equal(err.cause, inner)
	assert.ok(err.cause instanceof PoolClosedError)
})
