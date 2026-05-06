// Unit tests for `tediousDriver()` paths that don't need a live server.
// Live-DB paths are covered by `driver.int.ts`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialError, type DriverOptions } from '@tediousjs/mssql-core';
import { tediousDriver } from '../src/index.js';

describe('tediousDriver — unsupported credential kinds throw CredentialError', () => {
	const baseTransport = { host: 'localhost', port: 1433, trustServerCertificate: true };

	test('integrated', async () => {
		const driver = tediousDriver();
		await assert.rejects(
			() => driver.open({
				credential: { kind: 'integrated' },
				transport: baseTransport,
			} satisfies DriverOptions),
			(err: unknown) => {
				assert.ok(err instanceof CredentialError);
				assert.match((err).message, /not yet|integrated/);
				return true;
			},
		);
	});

	test('accessToken', async () => {
		const driver = tediousDriver();
		await assert.rejects(
			() => driver.open({
				credential: { kind: 'accessToken', token: 'abc' },
				transport: baseTransport,
			} satisfies DriverOptions),
			CredentialError,
		);
	});

	test('tokenProvider', async () => {
		const driver = tediousDriver();
		await assert.rejects(
			() => driver.open({
				credential: { kind: 'tokenProvider', provider: async () => 'tok' },
				transport: baseTransport,
			} satisfies DriverOptions),
			CredentialError,
		);
	});

	test('driverNative', async () => {
		const driver = tediousDriver();
		await assert.rejects(
			() => driver.open({
				credential: { kind: 'driverNative', config: {} },
				transport: baseTransport,
			} satisfies DriverOptions),
			CredentialError,
		);
	});
});

describe('tediousDriver — factory shape', () => {
	test('factory returns a Driver with name=tedious and an empty types registry', () => {
		const driver = tediousDriver();
		assert.equal(driver.name, 'tedious');
		assert.deepEqual(driver.types, {});
	});

	test('open is async', () => {
		const driver = tediousDriver();
		assert.equal(typeof driver.open, 'function');
		// First arg type is checked at compile time; runtime smoke just
		// verifies it returns a Promise even on rejection.
		const result = driver.open({
			credential: { kind: 'integrated' },
			transport: { host: 'localhost' },
		}).catch(() => undefined);
		assert.ok(result instanceof Promise);
	});
});
