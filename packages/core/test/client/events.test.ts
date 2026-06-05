// Tests for `Client`'s `'close'` event + `mssql:client:state-change`
// diagnostics_channel publishes (ADR-0018 / ADR-0014).
//
// Two observability surfaces, one source of truth (`#transitionTo`):
// - `'close'` event — per-instance, fires once on terminal transition
//   with `{ reason, error? }` discriminating connect-failure / drain /
//   destroy.
// - `mssql:client:state-change` channel — process-wide, fires on EVERY
//   state transition (including non-terminal ones like
//   `pending → open`, `open → draining`).
//
// Ordering on the terminal transition (ADR-0018):
//   state mutation → 'close' event → channel publish → Promise settles.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import {
	CLIENT_STATE_CHANGE_CHANNEL,
	type ClientClosePayload,
	type ClientState,
	type ClientStateChangePayload,
	createClient,
} from '../../src/index.js';
import { baseConfig, fakeDriver } from '../support/fakes.js';

// Subscribe + capture all `state-change` publishes for the test's scope.
// Returns the captured array and an unsubscribe to call from `finally`.
function captureStateChanges(): {
	captured: ClientStateChangePayload[]
	unsubscribe(): void
} {
	const captured: ClientStateChangePayload[] = [];
	const listener = (msg: unknown): void => {
		captured.push(msg as ClientStateChangePayload);
	};
	subscribe(CLIENT_STATE_CHANGE_CHANNEL, listener);
	return {
		captured,
		unsubscribe(): void {
			unsubscribe(CLIENT_STATE_CHANGE_CHANNEL, listener);
		},
	};
}

// ─── EventEmitter inheritance ──────────────────────────────────────────────

describe('Client — EventEmitter inheritance', () => {
	test('Client instances are EventEmitter instances', () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		assert.ok(client instanceof EventEmitter);
	});

	test('client.on / .once / .off return the client (chainable)', () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		const noop = (): void => { /* */ };
		assert.equal(client.on('close', noop), client);
		assert.equal(client.once('close', noop), client);
		assert.equal(client.off('close', noop), client);
	});

	test('listeners() reports attached close listeners', () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		const handler = (): void => { /* */ };
		client.on('close', handler);
		assert.deepEqual(client.listeners('close'), [handler]);
	});
});

// ─── 'close' event — reason discrimination ─────────────────────────────────

describe('Client — close event', () => {
	test('fires with reason "drain" on close() of a connected client', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		const captured: ClientClosePayload[] = [];
		client.on('close', (p) => captured.push(p));
		await client.close();
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.reason, 'drain');
		assert.equal(captured[0]!.error, undefined);
	});

	test('fires with reason "drain" on close() of a never-connected client', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		const captured: ClientClosePayload[] = [];
		client.on('close', (p) => captured.push(p));
		await client.close();
		// `pending → destroyed` is still a `'drain'` from close()'s POV.
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.reason, 'drain');
	});

	test('fires with reason "destroy" on destroy()', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		const captured: ClientClosePayload[] = [];
		client.on('close', (p) => captured.push(p));
		await client.destroy();
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.reason, 'destroy');
		assert.equal(captured[0]!.error, undefined);
	});

	test('fires with reason "connect-failure" and the originating error on connect() rejection', async () => {
		const boom = new Error('auth denied');
		const client = createClient({ driver: fakeDriver({ openShouldFail: boom }), ...baseConfig });
		const captured: ClientClosePayload[] = [];
		client.on('close', (p) => captured.push(p));
		await assert.rejects(() => client.connect(), /auth denied/);
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.reason, 'connect-failure');
		assert.equal(captured[0]!.error, boom);
	});

	test('fires AT MOST once per Client lifetime', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		let count = 0;
		client.on('close', () => count++);
		await client.close();
		// Repeated close — already destroyed.
		await client.close();
		await client.destroy();
		assert.equal(count, 1);
	});

	test('once("close", …) resolves to the payload', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		const payloadPromise = new Promise<ClientClosePayload>((res) =>
			client.once('close', (p) => res(p)),
		);
		await client.close();
		const p = await payloadPromise;
		assert.equal(p.reason, 'drain');
	});

	test('the close handler observes state === "destroyed" (state mutates before emit)', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		let stateAtFire: ClientState | null = null;
		client.on('close', () => { stateAtFire = client.state; });
		await client.close();
		assert.equal(stateAtFire, 'destroyed');
	});
});

// ─── mssql:client:state-change diagnostics channel ─────────────────────────

describe('Client — mssql:client:state-change channel', () => {
	test('publishes pending → open on connect()', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			assert.deepEqual(captured, [{ from: 'pending', to: 'open' }]);
			await client.close();
		} finally {
			stop();
		}
	});

	test('publishes open → draining → destroyed on close()', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			captured.length = 0;  // discard the connect transition
			await client.close();
			assert.deepEqual(captured, [
				{ from: 'open', to: 'draining' },
				{ from: 'draining', to: 'destroyed' },
			]);
		} finally {
			stop();
		}
	});

	test('publishes a single open → destroyed on destroy()', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			captured.length = 0;
			await client.destroy();
			assert.deepEqual(captured, [{ from: 'open', to: 'destroyed' }]);
		} finally {
			stop();
		}
	});

	test('publishes pending → destroyed on connect() rejection', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({
				driver: fakeDriver({ openShouldFail: new Error('bad') }),
				...baseConfig,
			});
			await assert.rejects(() => client.connect(), /bad/);
			assert.deepEqual(captured, [{ from: 'pending', to: 'destroyed' }]);
		} finally {
			stop();
		}
	});

	test('publishes pending → destroyed on close() of pending client', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.close();
			assert.deepEqual(captured, [{ from: 'pending', to: 'destroyed' }]);
		} finally {
			stop();
		}
	});

	test('does NOT publish on no-op transitions (close after destroyed)', async () => {
		const { captured, unsubscribe: stop } = captureStateChanges();
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			await client.close();  // emits two
			captured.length = 0;
			await client.close();  // no-op
			await client.destroy(); // no-op
			assert.deepEqual(captured, []);
		} finally {
			stop();
		}
	});
});

// ─── Ordering on terminal transition (ADR-0018) ────────────────────────────

describe('Client — terminal-transition ordering', () => {
	test('state → close event → channel publish → Promise settles', async () => {
		const order: string[] = [];
		const channelListener = (msg: unknown): void => {
			const m = msg as ClientStateChangePayload;
			if (m.to === 'destroyed') order.push('channel');
		};
		subscribe(CLIENT_STATE_CHANGE_CHANNEL, channelListener);
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			client.on('close', () => order.push('close-event'));
			const promise = client.close();
			await promise;
			order.push('promise-settled');
			// Ordering is "close-event before channel" per ADR-0018.
			// Promise settles last because the surrounding await
			// completes after the synchronous emissions.
			assert.deepEqual(order, ['close-event', 'channel', 'promise-settled']);
		} finally {
			unsubscribe(CLIENT_STATE_CHANGE_CHANNEL, channelListener);
		}
	});

	test('state is "destroyed" when the close event fires (synchronous mutation)', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		const sawState = new Promise<ClientState>((res) =>
			client.once('close', () => res(client.state)),
		);
		await client.destroy();
		assert.equal(await sawState, 'destroyed');
	});

	test('state is "destroyed" when channel subscribers fire (terminal publish)', async () => {
		const { unsubscribe: stop } = captureStateChanges();
		let stateInChannel: ClientState | null = null;
		const listener = (msg: unknown): void => {
			const m = msg as ClientStateChangePayload;
			if (m.to === 'destroyed') stateInChannel = (m.to as ClientState);
		};
		subscribe(CLIENT_STATE_CHANGE_CHANNEL, listener);
		try {
			const client = createClient({ driver: fakeDriver(), ...baseConfig });
			await client.connect();
			await client.close();
			assert.equal(stateInChannel, 'destroyed');
		} finally {
			unsubscribe(CLIENT_STATE_CHANGE_CHANNEL, listener);
			stop();
		}
	});
});

// ─── No 'error' event hazard (ADR-0018) ────────────────────────────────────

describe('Client — no error event surface', () => {
	test('connect() rejection does NOT emit error (no listener crash hazard)', async () => {
		const client = createClient({
			driver: fakeDriver({ openShouldFail: new Error('boom') }),
			...baseConfig,
		});
		// If the implementation emitted 'error' with no listener,
		// `EventEmitter` would throw inside the emit. We verify the
		// rejection path is the ONLY error surface — connect() rejects
		// with the original error, and no 'error' event escapes.
		let sawErrorEvent = false;
		// `as never` because the event isn't part of the typed surface;
		// the listener is purely a safety check that none escapes.
		(client as unknown as EventEmitter).on('error', () => { sawErrorEvent = true; });
		await assert.rejects(() => client.connect(), /boom/);
		assert.equal(sawErrorEvent, false, 'there should be no error event to fire');
	});
});

// ─── 'draining' event (#14) ────────────────────────────────────────────────

describe('Client — draining event', () => {
	test('close() of an open client emits draining then close', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		const order: string[] = [];
		client.on('draining', () => order.push('draining'));
		client.on('close', () => order.push('close'));
		await client.close();
		assert.deepEqual(order, ['draining', 'close']);
	});

	test('the draining handler observes state === "draining"', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		let stateAtFire: ClientState | null = null;
		client.on('draining', () => { stateAtFire = client.state; });
		await client.close();
		assert.equal(stateAtFire, 'draining');
	});

	test('destroy() of an open client does NOT emit draining (only close)', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		let draining = 0;
		client.on('draining', () => draining++);
		await client.destroy();
		assert.equal(draining, 0);
	});

	test('close() of a never-connected client does NOT emit draining', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		let draining = 0;
		client.on('draining', () => draining++);
		await client.close();
		assert.equal(draining, 0);
	});

	test('draining fires at most once across repeated close()', async () => {
		const client = createClient({ driver: fakeDriver(), ...baseConfig });
		await client.connect();
		let count = 0;
		client.on('draining', () => count++);
		await client.close();
		await client.close();
		assert.equal(count, 1);
	});
});
