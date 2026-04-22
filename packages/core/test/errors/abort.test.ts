import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
	AbortError,
	abortErrorFromSignal,
	MssqlError,
	TimeoutError,
} from '../../src/errors/index.js'

test('AbortError — name "AbortError", extends MssqlError', () => {
	const err = new AbortError('aborted')
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof AbortError)
	assert.equal(err.name, 'AbortError')
})

test('TimeoutError — name "TimeoutError", extends MssqlError', () => {
	const err = new TimeoutError('timed out')
	assert.ok(err instanceof MssqlError)
	assert.ok(err instanceof TimeoutError)
	assert.equal(err.name, 'TimeoutError')
})

test('abortErrorFromSignal — AbortSignal.timeout() reason produces TimeoutError', async () => {
	const signal = AbortSignal.timeout(1)
	await delay(5)
	assert.ok(signal.aborted)
	const err = abortErrorFromSignal(signal)
	assert.ok(err instanceof TimeoutError)
	assert.equal(err.name, 'TimeoutError')
	assert.equal(err.cause, signal.reason)
})

test('abortErrorFromSignal — controller.abort() reason produces AbortError', () => {
	const controller = new AbortController()
	controller.abort()
	const err = abortErrorFromSignal(controller.signal)
	assert.ok(err instanceof AbortError)
	assert.equal(err.name, 'AbortError')
	assert.equal(err.cause, controller.signal.reason)
})

test('abortErrorFromSignal — custom reason with name "TimeoutError" produces TimeoutError', () => {
	const controller = new AbortController()
	const reason = new DOMException('deadline', 'TimeoutError')
	controller.abort(reason)
	const err = abortErrorFromSignal(controller.signal)
	assert.ok(err instanceof TimeoutError)
	assert.equal(err.cause, reason)
})

test('abortErrorFromSignal — passes through connectionId / queryId', () => {
	const controller = new AbortController()
	controller.abort()
	const err = abortErrorFromSignal(controller.signal, {
		connectionId: 'conn_1',
		queryId: 'q_1',
	})
	assert.equal(err.connectionId, 'conn_1')
	assert.equal(err.queryId, 'q_1')
})
