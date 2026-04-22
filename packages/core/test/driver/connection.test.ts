import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type {
	ConnectionClosePayload,
	ConnectionEvents,
} from '../../src/driver/index.js'
import { ConnectionError } from '../../src/errors/index.js'

test('ConnectionEvents — typed EventEmitter carries close payload', () => {
	const ee = new EventEmitter<ConnectionEvents>()
	const received: ConnectionClosePayload[] = []
	ee.on('close', (p) => {
		received.push(p)
	})

	ee.emit('close', { reason: 'user' })
	ee.emit('close', { reason: 'reset' })
	ee.emit('close', { reason: 'remote' })
	ee.emit('close', {
		reason: 'error',
		error: new ConnectionError('boom'),
	})

	assert.equal(received.length, 4)
	assert.equal(received[0]?.reason, 'user')
	assert.equal(received[1]?.reason, 'reset')
	assert.equal(received[2]?.reason, 'remote')
	assert.equal(received[3]?.reason, 'error')
	assert.ok(received[3]?.error instanceof ConnectionError)
})
