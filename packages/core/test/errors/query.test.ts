import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ConstraintError,
	constraintKindFromNumber,
	MssqlError,
	MultipleRowsetsError,
	QueryError,
} from '../../src/errors/index.js';

describe('QueryError', () => {
	test('carries TDS fields verbatim', () => {
		const err = new QueryError('Violation of UNIQUE KEY', {
			number: 2627,
			state: 1,
			severity: 14,
			serverName: 'localhost',
			procName: 'usp_insert_user',
			lineNumber: 5,
		});
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof QueryError);
		assert.equal(err.name, 'QueryError');
		assert.equal(err.number, 2627);
		assert.equal(err.state, 1);
		assert.equal(err.severity, 14);
		assert.equal(err.serverName, 'localhost');
		assert.equal(err.procName, 'usp_insert_user');
		assert.equal(err.lineNumber, 5);
	});

	test('optional fields absent when not provided', () => {
		const err = new QueryError('x', { number: 1, state: 1, severity: 1 });
		assert.equal(err.serverName, undefined);
		assert.equal(err.procName, undefined);
		assert.equal(err.lineNumber, undefined);
	});
});

describe('ConstraintError', () => {
	test('extends QueryError with kind + constraintName', () => {
		const err = new ConstraintError('UQ violation', {
			number: 2627,
			state: 1,
			severity: 14,
			kind: 'unique',
			constraintName: 'UQ_users_email',
		});
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof QueryError);
		assert.ok(err instanceof ConstraintError);
		assert.equal(err.name, 'ConstraintError');
		assert.equal(err.kind, 'unique');
		assert.equal(err.constraintName, 'UQ_users_email');
		assert.equal(err.number, 2627);
	});
});

describe('constraintKindFromNumber', () => {
	test('unique maps 2627 and 2601', () => {
		assert.equal(constraintKindFromNumber(2627), 'unique');
		assert.equal(constraintKindFromNumber(2601), 'unique');
	});

	test('547 defaults to foreignKey', () => {
		assert.equal(constraintKindFromNumber(547), 'foreignKey');
	});

	test('547 with CHECK hint returns check', () => {
		assert.equal(
			constraintKindFromNumber(547, 'The INSERT statement conflicted with the CHECK constraint "CK_age"'),
			'check',
		);
	});

	test('notNull and default', () => {
		assert.equal(constraintKindFromNumber(515), 'notNull');
		assert.equal(constraintKindFromNumber(544), 'default');
		assert.equal(constraintKindFromNumber(8114), 'default');
	});

	test('unknown number returns undefined', () => {
		assert.equal(constraintKindFromNumber(1), undefined);
		assert.equal(constraintKindFromNumber(99999), undefined);
	});
});

describe('MultipleRowsetsError', () => {
	test('extends MssqlError, name set', () => {
		const err = new MultipleRowsetsError('expected 1 rowset, got 2');
		assert.ok(err instanceof MssqlError);
		assert.ok(err instanceof MultipleRowsetsError);
		assert.equal(err.name, 'MultipleRowsetsError');
	});
});
