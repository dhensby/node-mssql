import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Credential } from '../../src/config/index.js'

test('Credential — discriminates password by kind', () => {
	const cred: Credential = { kind: 'password', userName: 'sa', password: 'hunter2' }
	assert.equal(cred.kind, 'password')
	if (cred.kind === 'password') {
		assert.equal(cred.userName, 'sa')
		assert.equal(cred.password, 'hunter2')
	}
})

test('Credential — integrated has only a kind', () => {
	const cred: Credential = { kind: 'integrated' }
	assert.equal(cred.kind, 'integrated')
	assert.equal(Object.keys(cred).length, 1)
})

test('Credential — accessToken carries a token string', () => {
	const cred: Credential = { kind: 'accessToken', token: 'bearer-xyz' }
	assert.equal(cred.kind, 'accessToken')
	if (cred.kind === 'accessToken') {
		assert.equal(cred.token, 'bearer-xyz')
	}
})

test('Credential — tokenProvider is an async function the driver will call', async () => {
	let calls = 0
	const cred: Credential = {
		kind: 'tokenProvider',
		provider: async () => {
			calls += 1
			return 'live-token'
		},
	}
	if (cred.kind === 'tokenProvider') {
		assert.equal(await cred.provider(), 'live-token')
		assert.equal(await cred.provider(), 'live-token')
	}
	assert.equal(calls, 2)
})

test('Credential — driverNative accepts any shape on config', () => {
	const cred: Credential = {
		kind: 'driverNative',
		config: { type: 'some-tedious-internal-auth', foo: 1 },
	}
	assert.equal(cred.kind, 'driverNative')
})
