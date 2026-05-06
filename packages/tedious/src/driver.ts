/**
 * `tediousDriver()` — `Driver` factory for the tedious adapter (ADR-0010).
 *
 * Vertical-slice cut (V-3): supports the password credential and just
 * enough Transport fields to land a connection against the docker
 * `azure-sql-edge` container — host, port, database,
 * trustServerCertificate. The full credential + transport surface
 * (integrated, accessToken, tokenProvider, encrypt, instance, appName,
 * etc.) lands in round-out commits.
 *
 * Connect errors are wrapped in `ConnectionError({ cause })` for the
 * MVP. Round-out maps tedious's error taxonomy to the full core taxonomy
 * (`ConnectionError` / `CredentialError` / `QueryError` / `ConstraintError`).
 */

import { Connection as TediousConnection, type ConnectionConfiguration } from 'tedious';
import {
	type Connection,
	ConnectionError,
	CredentialError,
	type Credential,
	type Driver,
	type DriverOptions,
	nextId,
	type Transport,
} from '@tediousjs/mssql-core';
import { TediousConnectionWrapper } from './connection.js';

export function tediousDriver(): Driver {
	return {
		name: 'tedious',
		// Type registry will populate when ADR-0019's SqlType<T> system lands.
		types: {},
		async open(opts: DriverOptions): Promise<Connection> {
			const config = translateOptions(opts);
			const conn = await openTedious(config);
			return new TediousConnectionWrapper(conn, opts.id ?? nextId('conn'));
		},
	};
}

function translateOptions(opts: DriverOptions): ConnectionConfiguration {
	return {
		server: opts.transport.host,
		authentication: translateCredential(opts.credential),
		options: translateTransportOptions(opts.transport),
	};
}

function translateCredential(credential: Credential): NonNullable<ConnectionConfiguration['authentication']> {
	switch (credential.kind) {
		case 'password':
			return {
				type: 'default',
				options: {
					userName: credential.userName,
					password: credential.password,
				},
			};
		case 'integrated':
		case 'accessToken':
		case 'tokenProvider':
		case 'driverNative':
			throw new CredentialError(
				`@tediousjs/mssql-tedious V-3 only supports the 'password' credential kind; ` +
					`'${credential.kind}' lands in a round-out commit.`,
			);
	}
}

function translateTransportOptions(transport: Transport): NonNullable<ConnectionConfiguration['options']> {
	const options: NonNullable<ConnectionConfiguration['options']> = {};
	if (transport.port !== undefined) options.port = transport.port;
	if (transport.database !== undefined) options.database = transport.database;
	if (transport.trustServerCertificate !== undefined) {
		options.trustServerCertificate = transport.trustServerCertificate;
	}
	// Round-out commits wire encrypt / serverCertificate / instance / appName /
	// workstationId / applicationIntent / multiSubnetFailover / packetSize +
	// the `native` escape hatch.
	return options;
}

async function openTedious(config: ConnectionConfiguration): Promise<TediousConnection> {
	const conn = new TediousConnection(config);
	return new Promise<TediousConnection>((resolve, reject) => {
		// `connect(callback)` is the canonical tedious shape — no race
		// between `connect` / `error` event listeners, and the callback
		// fires exactly once.
		conn.connect((err: Error | undefined) => {
			if (err !== undefined && err !== null) {
				reject(new ConnectionError('failed to connect', { cause: err }));
				return;
			}
			resolve(conn);
		});
	});
}
