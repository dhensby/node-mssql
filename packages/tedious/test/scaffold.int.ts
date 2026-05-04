import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationConfig, SKIP_REASON } from './integration.js';

// Sanity-check that the integration scaffold itself works:
// - When env is unset: this test reports a skip with SKIP_REASON.
// - When env is set: this test asserts that the config helper parsed it.
//
// The real end-to-end integration test (`SELECT 1` against a live server)
// lands in Commit C alongside the tedious driver runtime.
describe('integration scaffold', () => {
	test('config helper parses env', { skip: integrationConfig === null ? SKIP_REASON : false }, () => {
		const config = integrationConfig;
		assert.notEqual(config, null);
		if (config === null) return;
		assert.equal(typeof config.host, 'string');
		assert.equal(typeof config.port, 'number');
		assert.equal(typeof config.user, 'string');
		assert.equal(typeof config.password, 'string');
		assert.equal(typeof config.database, 'string');
	});
});
