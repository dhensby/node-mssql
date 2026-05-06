import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES } from 'tedious';
import { inferParameterType } from '../src/parameter-types.js';

describe('inferParameterType — primitives', () => {
	test('null → NVarChar(null)', () => {
		const r = inferParameterType(null);
		assert.equal(r.type, TYPES.NVarChar);
		assert.equal(r.value, null);
	});

	test('undefined → NVarChar(null) — typed-NULL on the wire', () => {
		const r = inferParameterType(undefined);
		assert.equal(r.type, TYPES.NVarChar);
		assert.equal(r.value, null);
	});

	test('string → NVarChar', () => {
		const r = inferParameterType('hello');
		assert.equal(r.type, TYPES.NVarChar);
		assert.equal(r.value, 'hello');
	});

	test('boolean true → Bit', () => {
		const r = inferParameterType(true);
		assert.equal(r.type, TYPES.Bit);
		assert.equal(r.value, true);
	});

	test('boolean false → Bit', () => {
		const r = inferParameterType(false);
		assert.equal(r.type, TYPES.Bit);
		assert.equal(r.value, false);
	});

	test('bigint → BigInt', () => {
		const r = inferParameterType(123456789012345678901234567890n);
		assert.equal(r.type, TYPES.BigInt);
		assert.equal(r.value, 123456789012345678901234567890n);
	});
});

describe('inferParameterType — numbers', () => {
	test('safe positive integer → Int', () => {
		const r = inferParameterType(42);
		assert.equal(r.type, TYPES.Int);
		assert.equal(r.value, 42);
	});

	test('safe negative integer → Int', () => {
		const r = inferParameterType(-100);
		assert.equal(r.type, TYPES.Int);
		assert.equal(r.value, -100);
	});

	test('zero → Int', () => {
		const r = inferParameterType(0);
		assert.equal(r.type, TYPES.Int);
		assert.equal(r.value, 0);
	});

	test('Int32 max → Int', () => {
		const r = inferParameterType(2_147_483_647);
		assert.equal(r.type, TYPES.Int);
	});

	test('above Int32 max → Float (wider range)', () => {
		const r = inferParameterType(2_147_483_648);
		assert.equal(r.type, TYPES.Float);
		assert.equal(r.value, 2_147_483_648);
	});

	test('below Int32 min → Float', () => {
		const r = inferParameterType(-2_147_483_649);
		assert.equal(r.type, TYPES.Float);
	});

	test('non-integer → Float', () => {
		const r = inferParameterType(3.14);
		assert.equal(r.type, TYPES.Float);
		assert.equal(r.value, 3.14);
	});
});

describe('inferParameterType — date and binary', () => {
	test('Date → DateTime2', () => {
		const date = new Date('2026-05-06T00:00:00Z');
		const r = inferParameterType(date);
		assert.equal(r.type, TYPES.DateTime2);
		assert.equal(r.value, date);
	});

	test('Uint8Array → VarBinary', () => {
		const buf = new Uint8Array([1, 2, 3]);
		const r = inferParameterType(buf);
		assert.equal(r.type, TYPES.VarBinary);
		assert.equal(r.value, buf);
	});

	test('Buffer (which extends Uint8Array) → VarBinary', () => {
		const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		const r = inferParameterType(buf);
		assert.equal(r.type, TYPES.VarBinary);
		assert.equal(r.value, buf);
	});
});

describe('inferParameterType — unsupported types', () => {
	test('plain object throws TypeError pointing at ADR-0019', () => {
		assert.throws(
			() => inferParameterType({ x: 1 }),
			(err: unknown) => {
				assert.ok(err instanceof TypeError);
				assert.match((err).message, /ADR-0019/);
				return true;
			},
		);
	});

	test('array throws TypeError', () => {
		assert.throws(() => inferParameterType([1, 2, 3]), TypeError);
	});

	test('Symbol throws TypeError', () => {
		assert.throws(() => inferParameterType(Symbol('x')), TypeError);
	});

	test('function throws TypeError', () => {
		assert.throws(() => inferParameterType(() => 0), TypeError);
	});
});
