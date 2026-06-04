// Shared test fakes for the core package.
//
// Before this module, `FakeConnection` was reimplemented in ~9 test
// files (and `fakeDriver` / `makeFakePool` / `baseConfig` in several),
// each a slightly different hand-roll of the same port shapes. These
// factories are the single, configurable definition.
//
// This file lives under test/support/ (not `*.test.ts` / `*.int.ts`),
// so the test runner — which globs only `*.test.js` — compiles but does
// NOT execute it as a test suite.
//
// Tracking is via node:test's `mock.fn()`: every method/callback that a
// test verifies is a mock, so call counts and arguments come from
// `.mock` rather than hand-maintained counters. Behaviour (scripted
// results, failure injection, overlap detection, gating) lives in the
// mock's implementation. A fresh fake per test means fresh mocks — no
// cross-test reset needed. Failure fields are mutable so a test can arm
// them after construction.

import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import type {
	ClientConfig,
	Connection,
	ConnectionEvents,
	Driver,
	DriverOptions,
	ExecuteRequest,
	Pool,
	PooledConnection,
	PoolStats,
	RequestRunner,
	ResultEvent,
	TxOptions,
} from '../../src/index.js';

// ─── fakeConnection ─────────────────────────────────────────────────────────

export interface FakeConnectionOptions {
	id?: string
	/**
	 * Events `execute()` yields. A fixed list, or a per-request function.
	 * Default: a single `{ kind: 'done' }`.
	 */
	execute?: readonly ResultEvent[] | ((req: ExecuteRequest) => readonly ResultEvent[])
	/** Reject overlapping wire ops (models TDS's one-in-flight-request rule). */
	detectOverlap?: boolean
}

const DONE: ResultEvent = { kind: 'done' };

/**
 * Configurable `Connection`-port fake. Every port method is a `mock.fn`,
 * so tests assert with `conn.commit.mock.callCount()` /
 * `conn.savepoint.mock.calls[0].arguments[0]`, etc. Set any `fail*` field
 * (at construction or later) to make that method reject. Opt into
 * `detectOverlap` and use {@link FakeConnection.holdNextExecute} for the
 * concurrency tests.
 */
export class FakeConnection extends EventEmitter<ConnectionEvents> implements Connection {
	readonly id: string;

	// Failure injection — armable any time.
	failBegin?: Error;
	failCommit?: Error;
	failRollback?: Error;
	failReset?: Error;
	failPing?: Error;
	failClose?: Error;

	#execute: FakeConnectionOptions['execute'];
	readonly #detectOverlap: boolean;
	#inFlight: string | null = null;
	#executeGate: Promise<void> | undefined;

	constructor(opts: FakeConnectionOptions = {}) {
		super();
		this.id = opts.id ?? 'conn_fake';
		this.#execute = opts.execute;
		this.#detectOverlap = opts.detectOverlap ?? false;
	}

	/** Set the events `execute()` yields, after construction. */
	scriptExecute(script: FakeConnectionOptions['execute']): void {
		this.#execute = script;
	}

	/** Hold the next `execute()` in flight until the returned fn is called. */
	holdNextExecute(): () => void {
		let release!: () => void;
		this.#executeGate = new Promise<void>((res) => { release = res; });
		return release;
	}

	#enter(label: string): void {
		if (this.#detectOverlap && this.#inFlight !== null) {
			throw new Error(`overlapping request: ${label} started while ${this.#inFlight} in flight`);
		}
		this.#inFlight = label;
	}
	#exit(): void {
		this.#inFlight = null;
	}

	#eventsFor(req: ExecuteRequest): readonly ResultEvent[] {
		if (this.#execute === undefined) return [DONE];
		return typeof this.#execute === 'function' ? this.#execute(req) : this.#execute;
	}

	async *#runExecute(req: ExecuteRequest, gate: Promise<void> | undefined): AsyncIterable<ResultEvent> {
		this.#enter('execute');
		try {
			if (gate !== undefined) await gate;
			await Promise.resolve();
			for (const ev of this.#eventsFor(req)) yield ev;
		} finally {
			this.#exit();
		}
	}

	execute = mock.fn((req: ExecuteRequest, _signal?: AbortSignal): AsyncIterable<ResultEvent> => {
		const gate = this.#executeGate;
		this.#executeGate = undefined;
		return this.#runExecute(req, gate);
	});

	beginTransaction = mock.fn(async (_opts?: TxOptions): Promise<void> => {
		this.#enter('beginTransaction');
		try { await Promise.resolve(); if (this.failBegin) throw this.failBegin; } finally { this.#exit(); }
	});
	commit = mock.fn(async (): Promise<void> => {
		this.#enter('commit');
		try { await Promise.resolve(); if (this.failCommit) throw this.failCommit; } finally { this.#exit(); }
	});
	rollback = mock.fn(async (): Promise<void> => {
		this.#enter('rollback');
		try { await Promise.resolve(); if (this.failRollback) throw this.failRollback; } finally { this.#exit(); }
	});
	savepoint = mock.fn(async (_name: string): Promise<void> => {
		this.#enter('savepoint');
		try { await Promise.resolve(); } finally { this.#exit(); }
	});
	rollbackToSavepoint = mock.fn(async (_name: string): Promise<void> => {
		this.#enter('rollbackToSavepoint');
		try { await Promise.resolve(); } finally { this.#exit(); }
	});
	prepare = mock.fn(async (): Promise<{ id: string }> => ({ id: 'prep_fake' }));
	bulkLoad = mock.fn(async (): Promise<{ rowsAffected: number }> => ({ rowsAffected: 0 }));
	reset = mock.fn(async (): Promise<void> => { if (this.failReset) throw this.failReset; });
	ping = mock.fn(async (): Promise<void> => { if (this.failPing) throw this.failPing; });
	close = mock.fn(async (): Promise<void> => { if (this.failClose) throw this.failClose; });
}

export const fakeConnection = (opts?: FakeConnectionOptions): FakeConnection =>
	new FakeConnection(opts);

// ─── fakeDriver ─────────────────────────────────────────────────────────────

export interface FakeDriverOptions {
	/** Throw from `open()` (e.g. to simulate a connect failure). */
	openShouldFail?: Error
	/** Produce the connection for each open (call N is 1-based). Default: a fresh fakeConnection. */
	connectionFactory?: (openCount: number) => Connection | Promise<Connection>
}

/**
 * `Driver` fake. Usable directly (`driver: fakeDriver()`); `open` is a
 * `mock.fn`, so assert opens via `driver.open.mock.callCount()` and the
 * `DriverOptions` via `driver.open.mock.calls[i].arguments[0]`.
 */
export const fakeDriver = (opts: FakeDriverOptions = {}) => {
	let opens = 0;
	const open = mock.fn(async (_driverOpts: DriverOptions): Promise<Connection> => {
		opens++;
		if (opts.openShouldFail !== undefined) throw opts.openShouldFail;
		return opts.connectionFactory !== undefined ? await opts.connectionFactory(opens) : fakeConnection();
	});
	return { name: 'fake', types: {}, open } satisfies Driver;
};

// ─── fakePool ───────────────────────────────────────────────────────────────

/**
 * Single-connection `Pool` fake over a fixed connection. One acquire at a
 * time (rejects a second concurrent acquire). `pool.acquire` / `.drain` /
 * `.destroy` and the shared `release` are `mock.fn`s — assert via
 * `pool.acquire.mock.callCount()` / `release.mock.callCount()`. `release`
 * is the same fn the pooled connection's `release` / `destroy` / disposal
 * call; it rides alongside the pool (returned, not on the pool object).
 */
export const fakePool = (conn: Connection) => {
	let inUse = false;
	const stats: PoolStats = { size: 1, available: 1, inUse: 0, pending: 0 };

	const release = mock.fn(async (): Promise<void> => { if (inUse) inUse = false; });
	const acquire = mock.fn(async (signal?: AbortSignal): Promise<PooledConnection> => {
		signal?.throwIfAborted();
		if (inUse) throw new Error('fakePool supports one acquire at a time');
		inUse = true;
		const pooled: PooledConnection = {
			connection: conn,
			release,
			destroy: release,
			async [Symbol.asyncDispose]() { await release(); },
		};
		return pooled;
	});
	const drain = mock.fn(async (): Promise<void> => { /* */ });
	const destroy = mock.fn(async (): Promise<void> => { /* */ });

	const pool = { state: 'open' as const, stats, acquire, drain, destroy } satisfies Pool;
	return { pool, release };
};

// ─── fakeRunner ─────────────────────────────────────────────────────────────

/**
 * `RequestRunner` that yields a scripted sequence of `ResultEvent`s.
 * Models the pool-bound runner (ADR-0023). `run` is a `mock.fn`; the
 * generator's `finally` calls a `release` `mock.fn` so cancel/dispose
 * ordering is observable — assert via `runner.run.mock.callCount()` /
 * `runner.release.mock.callCount()`.
 */
export const fakeRunner = (events: readonly ResultEvent[]) => {
	const release = mock.fn((): void => { /* iteration settled (drain / cancel) */ });
	const run = mock.fn((_req: ExecuteRequest, _signal?: AbortSignal): AsyncIterable<ResultEvent> =>
		(async function* () {
			try {
				for (const ev of events) yield ev;
			} finally {
				release();
			}
		})());
	const runner = { run } satisfies RequestRunner;
	return { runner, release };
};

// ─── shared config ──────────────────────────────────────────────────────────

/** Minimal `ClientConfig` for tests that need one (driver filled in per test). */
export const baseConfig: Omit<ClientConfig, 'driver'> = {
	credential: { kind: 'integrated' },
	transport: { host: 'db.local' },
};

/** Minimal `DriverOptions` for tests that drive a pool/driver directly. */
export const fakeDriverOptions: DriverOptions = {
	credential: { kind: 'integrated' },
	transport: { host: 'db.local' },
};
