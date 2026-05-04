import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.js';

describe('@tediousjs/mssql-core', () => {
	test('module loads and exposes its package name', () => {
		assert.equal(PACKAGE_NAME, '@tediousjs/mssql-core');
	});
});
