import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type ExecuteRequest,
	makeSqlTag,
	Query,
	type RequestRunner,
	type ResultEvent,
} from '../../src/index.js';

// Capture-only runner — records the ExecuteRequest the tag built and
// resolves with empty rows. Lets the tag tests assert on what the SQL
// tag emits without needing a Driver / Connection / Pool stack.
const makeCaptureRunner = (): { runner: RequestRunner; captured: ExecuteRequest[] } => {
	const captured: ExecuteRequest[] = [];
	const runner: RequestRunner = {
		run(req: ExecuteRequest): AsyncIterable<ResultEvent> {
			captured.push(req);
			return (async function* () {
				yield { kind: 'done' };
			})();
		},
	};
	return { runner, captured };
};

// ─── Construction ───────────────────────────────────────────────────────────

describe('makeSqlTag — construction', () => {
	test('returns a Query<T> from a tagged-template invocation', () => {
		const { runner } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const q = sql`SELECT 1`;
		assert.ok(q instanceof Query);
	});

	test('each tag invocation produces a fresh Query (single-consumption is per-Query)', async () => {
		const { runner } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const q1 = sql`SELECT 1`;
		const q2 = sql`SELECT 1`;
		assert.notEqual(q1, q2);
		await q1; // exhaust q1
		// q2 is independent — still consumable.
		await q2;
	});
});

// ─── SQL string assembly + parameter binding ────────────────────────────────

describe('makeSqlTag — SQL assembly', () => {
	test('plain literal with no interpolations passes through verbatim', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql`SELECT 1`;
		assert.equal(captured.length, 1);
		assert.equal(captured[0]?.sql, 'SELECT 1');
		assert.deepEqual(captured[0]?.params, []);
	});

	test('single interpolation emits @p0 placeholder + ParamBinding', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql`SELECT ${42}`;
		assert.equal(captured[0]?.sql, 'SELECT @p0');
		assert.deepEqual(captured[0]?.params, [{ name: 'p0', value: 42 }]);
	});

	test('multiple interpolations emit sequential @p0, @p1, ... placeholders', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql`SELECT * FROM t WHERE a = ${1} AND b = ${'two'} AND c = ${null}`;
		assert.equal(
			captured[0]?.sql,
			'SELECT * FROM t WHERE a = @p0 AND b = @p1 AND c = @p2',
		);
		assert.deepEqual(captured[0]?.params, [
			{ name: 'p0', value: 1 },
			{ name: 'p1', value: 'two' },
			{ name: 'p2', value: null },
		]);
	});

	test('preserves text following the last interpolation', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql`UPDATE t SET x = ${1} WHERE id = ${2} RETURNING *`;
		assert.equal(
			captured[0]?.sql,
			'UPDATE t SET x = @p0 WHERE id = @p1 RETURNING *',
		);
	});

	test('preserves empty leading / trailing strings', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql`${1}+${2}`;
		assert.equal(captured[0]?.sql, '@p0+@p1');
	});

	test('parameter values pass through verbatim (no kernel-side coercion)', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const date = new Date('2026-05-06T00:00:00Z');
		const buf = new Uint8Array([1, 2, 3]);
		await sql`SELECT ${date}, ${buf}, ${undefined}, ${true}`;
		assert.deepEqual(captured[0]?.params, [
			{ name: 'p0', value: date },
			{ name: 'p1', value: buf },
			{ name: 'p2', value: undefined },
			{ name: 'p3', value: true },
		]);
	});
});

// ─── Lazy execution ─────────────────────────────────────────────────────────

describe('makeSqlTag — lazy execution', () => {
	test('building a Query via the tag does not invoke the runner', () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const _q = sql`SELECT 1`;
		assert.equal(captured.length, 0, 'runner not called at tag invocation');
		assert.ok(_q instanceof Query);
	});

	test('runner fires only when a terminal (await) is reached', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const q = sql`SELECT ${1}`;
		assert.equal(captured.length, 0);
		await q;
		assert.equal(captured.length, 1);
	});
});

// ─── sql.unsafe — raw SQL escape hatch (ADR-0006) ───────────────────────────
//
// `sql.unsafe(text, params?)` runs SQL the library did not author —
// query-builder output, external migration tooling, etc. It returns
// the same `Query<T>` shape so the full terminal surface (`.all` /
// `.iterate` / `.run` / `.result` / `.rowsets` / `.raw` / `.columns`
// / `.meta`) works identically. Parameters bind on the wire; only
// the text is raw.

describe('sql.unsafe — raw text', () => {
	test('returns a Query<T>', () => {
		const { runner } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const q = sql.unsafe('SELECT 1');
		assert.ok(q instanceof Query);
	});

	test('raw text passes through verbatim, with no params', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql.unsafe('SELECT 1 AS n');
		assert.equal(captured[0]?.sql, 'SELECT 1 AS n');
		assert.deepEqual(captured[0]?.params, []);
	});

	test('object params bind by name', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql.unsafe('SELECT * FROM t WHERE a = @id AND b = @name', {
			id: 1,
			name: 'alice',
		});
		assert.equal(captured[0]?.sql, 'SELECT * FROM t WHERE a = @id AND b = @name');
		assert.deepEqual(captured[0]?.params, [
			{ name: 'id', value: 1 },
			{ name: 'name', value: 'alice' },
		]);
	});

	test('array params bind positionally as p0, p1, …', async () => {
		// Positional binding lets builders that emit `@p0 / @p1 / …` (the
		// same convention the tag emits) feed straight in.
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql.unsafe('SELECT * FROM t WHERE a = @p0 AND b = @p1', [1, 'alice']);
		assert.equal(captured[0]?.sql, 'SELECT * FROM t WHERE a = @p0 AND b = @p1');
		assert.deepEqual(captured[0]?.params, [
			{ name: 'p0', value: 1 },
			{ name: 'p1', value: 'alice' },
		]);
	});

	test('object params preserve verbatim values (no kernel coercion)', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const date = new Date('2026-05-06T00:00:00Z');
		await sql.unsafe('SELECT * FROM t WHERE created_at = @d', { d: date });
		assert.deepEqual(captured[0]?.params, [{ name: 'd', value: date }]);
	});

	test('lazy execution — runner not invoked until a terminal fires', () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		sql.unsafe('SELECT 1');
		assert.equal(captured.length, 0);
	});

	test('returned Query supports the full terminal surface (.run / .meta / .iterate)', async () => {
		// Smoke check that the Query is fully wired — not just a partial
		// construct.
		const { runner } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		const meta = await sql.unsafe('SELECT 1').run();
		assert.equal(meta.completed, true);
	});

	test('empty array params is valid (no params bound)', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql.unsafe('SELECT 1', []);
		assert.deepEqual(captured[0]?.params, []);
	});

	test('empty object params is valid (no params bound)', async () => {
		const { runner, captured } = makeCaptureRunner();
		const sql = makeSqlTag(runner);
		await sql.unsafe('SELECT 1', {});
		assert.deepEqual(captured[0]?.params, []);
	});
});
