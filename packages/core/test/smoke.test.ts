import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PACKAGE_NAME } from '../src/index.js'

test('core module loads and exposes its package name', () => {
	assert.equal(PACKAGE_NAME, '@tediousjs/mssql-core')
})
