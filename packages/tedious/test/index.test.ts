import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as tedious from '../src/index.js';

describe('@tediousjs/mssql-tedious', () => {
	test('package loads', () => {
		// Phase 1 skeleton: the package re-exports nothing yet; the runtime
		// lands in Commit C. This test exists so `npm test` has at least one
		// unit test to run while the package is empty.
		assert.equal(typeof tedious, 'object');
	});
});
