// Unit tests for the tedious → core `MssqlError` taxonomy translation
// (ADR-0017). Synthetic tedious `RequestError` / `ConnectionError`
// instances exercise each mapping branch without a live server; the
// real-server round-trips live in driver.int.ts.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionError as TediousConnectionError, RequestError } from 'tedious';
import {
	ConnectionError,
	ConstraintError,
	CredentialError,
	DriverError,
	QueryError,
	TransactionError,
} from '@tediousjs/mssql-core';
import { mapConnectError, mapQueryError, mapTransactionError } from '../src/errors.js';

// Build a tedious `RequestError` the way the token handler does: construct
// with (message, code), then assign the TDS error-token fields.
interface TdsFields {
	number?: number
	state?: number
	class?: number
	serverName?: string
	procName?: string
	lineNumber?: number
}
const requestError = (message: string, code: string, fields: TdsFields = {}): RequestError => {
	const err = new RequestError(message, code);
	Object.assign(err, fields);
	return err;
};

describe('mapQueryError — server statement rejections', () => {
	test('unique violation (2627) → ConstraintError kind "unique" with constraintName', () => {
		const native = requestError(
			"Violation of UNIQUE KEY constraint 'UQ_t_x'. Cannot insert duplicate key in object 'dbo.t'. The duplicate key value is (1).",
			'EREQUEST',
			{ number: 2627, state: 1, class: 14, serverName: 'srv', lineNumber: 1 },
		);
		const err = mapQueryError(native, { connectionId: 'conn_1' });
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.kind, 'unique');
		assert.equal(err.constraintName, 'UQ_t_x');
		assert.equal(err.number, 2627);
		assert.equal(err.state, 1);
		assert.equal(err.severity, 14);
		assert.equal(err.serverName, 'srv');
		assert.equal(err.lineNumber, 1);
		assert.equal(err.connectionId, 'conn_1');
		assert.equal(err.cause, native, 'native error preserved on cause');
		assert.equal(err.message, native.message, 'server message text verbatim');
	});

	test('duplicate-key unique index (2601) → kind "unique", index name parsed', () => {
		const native = requestError(
			"Cannot insert duplicate key row in object 'dbo.t' with unique index 'IX_t_x'. The duplicate key value is (1).",
			'EREQUEST',
			{ number: 2601, state: 1, class: 14 },
		);
		const err = mapQueryError(native);
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.kind, 'unique');
		assert.equal(err.constraintName, 'IX_t_x');
	});

	test('547 with FK message → kind "foreignKey"', () => {
		const native = requestError(
			'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_t_ref". The conflict occurred in database "db", table "dbo.ref", column \'id\'.',
			'EREQUEST',
			{ number: 547, state: 0, class: 16 },
		);
		const err = mapQueryError(native);
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.kind, 'foreignKey');
		assert.equal(err.constraintName, 'FK_t_ref');
	});

	test('547 with CHECK message → kind "check" (number overload disambiguated by text)', () => {
		const native = requestError(
			'The INSERT statement conflicted with the CHECK constraint "CK_positive". The conflict occurred in database "db", table "dbo.t".',
			'EREQUEST',
			{ number: 547, state: 0, class: 16 },
		);
		const err = mapQueryError(native);
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.kind, 'check');
		assert.equal(err.constraintName, 'CK_positive');
	});

	test('NOT NULL violation (515) → kind "notNull", no constraintName', () => {
		const native = requestError(
			"Cannot insert the value NULL into column 'c', table 'dbo.t'; column does not allow nulls. INSERT fails.",
			'EREQUEST',
			{ number: 515, state: 2, class: 16 },
		);
		const err = mapQueryError(native);
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.kind, 'notNull');
		assert.equal(err.constraintName, undefined);
	});

	test('non-constraint server error → plain QueryError (not ConstraintError)', () => {
		const native = requestError("Invalid object name 'dbo.nope'.", 'EREQUEST', {
			number: 208,
			state: 1,
			class: 16,
		});
		const err = mapQueryError(native);
		assert.ok(err instanceof QueryError);
		assert.ok(!(err instanceof ConstraintError));
		assert.equal(err.number, 208);
	});

	test('connection drop mid-request (RequestError, no number, ESOCKET) → ConnectionError', () => {
		const native = requestError('Connection lost', 'ESOCKET');
		const err = mapQueryError(native);
		assert.ok(err instanceof ConnectionError);
		assert.ok(!(err instanceof QueryError));
	});

	test('unrecognised error → DriverError (wrapper of last resort)', () => {
		const native = new Error('something weird');
		const err = mapQueryError(native, { connectionId: 'conn_9' });
		assert.ok(err instanceof DriverError);
		assert.equal(err.cause, native);
		assert.equal(err.connectionId, 'conn_9');
	});
});

describe('mapConnectError — connect/reset failures', () => {
	test('login failure (ELOGIN) → CredentialError', () => {
		const native = new TediousConnectionError("Login failed for user 'sa'.", 'ELOGIN');
		const err = mapConnectError(native, { connectionId: 'conn_2' });
		assert.ok(err instanceof CredentialError);
		assert.ok(err instanceof ConnectionError, 'CredentialError is-a ConnectionError');
		assert.equal(err.connectionId, 'conn_2');
		assert.equal(err.cause, native);
	});

	test('login failure by number (18456) → CredentialError', () => {
		const native = requestError("Login failed for user 'sa'.", 'EREQUEST', { number: 18456 });
		const err = mapConnectError(native);
		assert.ok(err instanceof CredentialError);
	});

	test('socket failure (ESOCKET) → ConnectionError (not Credential)', () => {
		const native = new TediousConnectionError('Failed to connect to host:1433', 'ESOCKET');
		const err = mapConnectError(native);
		assert.ok(err instanceof ConnectionError);
		assert.ok(!(err instanceof CredentialError));
	});

	test('unrecognised connect error → DriverError', () => {
		const err = mapConnectError('not even an error');
		assert.ok(err instanceof DriverError);
	});
});

describe('mapTransactionError — transaction control-op failures', () => {
	test('transaction-state error (e.g. 3902) → TransactionError, number on cause', () => {
		const native = requestError(
			'The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.',
			'EREQUEST',
			{ number: 3902, state: 1, class: 16 },
		);
		const err = mapTransactionError(native, { connectionId: 'conn_3' });
		assert.ok(err instanceof TransactionError);
		assert.equal(err.connectionId, 'conn_3');
		assert.equal(err.cause, native);
		assert.equal((err.cause as RequestError).number, 3902);
	});

	test('connection death during a tx op → ConnectionError (not TransactionError)', () => {
		const native = new TediousConnectionError('Connection closed', 'ECLOSE');
		const err = mapTransactionError(native);
		assert.ok(err instanceof ConnectionError);
		assert.ok(!(err instanceof TransactionError));
	});
});
