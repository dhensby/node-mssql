import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EncryptOptions, Transport } from '../../src/config/index.js'

test('Transport — minimal shape requires only host', () => {
	const t: Transport = { host: 'db.local' }
	assert.equal(t.host, 'db.local')
})

test('Transport — full shape carries optional fields', () => {
	const t: Transport = {
		host: 'db.local',
		port: 1433,
		database: 'app',
		instance: 'SQLEXPRESS',
		encrypt: true,
		trustServerCertificate: false,
		appName: 'my-service',
	}
	assert.equal(t.port, 1433)
	assert.equal(t.database, 'app')
	assert.equal(t.instance, 'SQLEXPRESS')
	assert.equal(t.encrypt, true)
	assert.equal(t.trustServerCertificate, false)
	assert.equal(t.appName, 'my-service')
})

test('Transport — encrypt accepts EncryptOptions with strict', () => {
	const encrypt: EncryptOptions = { strict: true }
	const t: Transport = { host: 'db.local', encrypt }
	assert.deepEqual(t.encrypt, { strict: true })
})

test('Transport — serverCertificate accepts string or Uint8Array', () => {
	const pem: Transport = { host: 'db.local', serverCertificate: '-----BEGIN CERTIFICATE-----' }
	const der: Transport = { host: 'db.local', serverCertificate: new Uint8Array([0, 1, 2]) }
	assert.equal(typeof pem.serverCertificate, 'string')
	assert.ok(der.serverCertificate instanceof Uint8Array)
})

test('Transport — native escape hatch accepts arbitrary config', () => {
	const t: Transport = {
		host: 'db.local',
		native: { rowCollectionOnDone: true },
	}
	assert.deepEqual(t.native, { rowCollectionOnDone: true })
})
