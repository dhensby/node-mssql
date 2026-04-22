import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	ConnectionError,
	CredentialError,
	MssqlError,
} from '../../src/errors/index.js'

test('ConnectionError — extends MssqlError, name set', () => {
	const err = new ConnectionError('cannot reach server')
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof ConnectionError)
	assert.equal(err.name, 'ConnectionError')
})

test('CredentialError — extends ConnectionError and MssqlError', () => {
	const err = new CredentialError('bad password')
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof ConnectionError)
	assert.ok(err instanceof CredentialError)
	assert.equal(err.name, 'CredentialError')
})
