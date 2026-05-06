import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { requireIntegrationConfig } from './integration.js';

// Sanity-check that the env-var integration scaffold parses correctly.
// `requireIntegrationConfig()` throws with a help message if env is unset
// — running this test against an empty environment is a hard failure
// (per `integration.ts` header), so "test suite passes" implies "tests
// actually ran against a real DB."
describe('integration scaffold', () => {
	test('config helper parses env into IntegrationConfig', () => {
		const config = requireIntegrationConfig();
		assert.equal(typeof config.host, 'string');
		assert.equal(typeof config.port, 'number');
		assert.equal(typeof config.user, 'string');
		assert.equal(typeof config.password, 'string');
		assert.equal(typeof config.database, 'string');
		assert.ok(config.password.length > 0, 'password is non-empty');
	});
});
