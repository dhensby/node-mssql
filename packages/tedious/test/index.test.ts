import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tediousDriver } from '../src/index.js';

describe('@tediousjs/mssql-tedious', () => {
	test('exports a `tediousDriver` factory', () => {
		assert.equal(typeof tediousDriver, 'function');
	});

	test('factory builds a Driver with the expected shape', () => {
		const driver = tediousDriver();
		assert.equal(driver.name, 'tedious');
		assert.equal(typeof driver.open, 'function');
		assert.equal(typeof driver.types, 'object');
	});
});
