import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateMachine, type StateMachine } from '../../src/util/index.js';

type S = 'pending' | 'open' | 'draining' | 'destroyed';

const TRANSITIONS: Record<S, readonly S[]> = {
	pending: ['open', 'destroyed'],
	open: ['draining', 'destroyed'],
	draining: ['destroyed'],
	destroyed: [],
};

const make = (initial: S, onTransition?: (from: S, to: S) => void): StateMachine<S> =>
	createStateMachine<S>({
		initial,
		transitions: TRANSITIONS,
		...(onTransition !== undefined ? { onTransition } : {}),
	});

describe('createStateMachine()', () => {
	test('starts in the initial state', () => {
		assert.equal(make('pending').state, 'pending');
	});

	test('is() matches the current state, single or multi', () => {
		const sm = make('open');
		assert.ok(sm.is('open'));
		assert.ok(sm.is('draining', 'open'));
		assert.ok(!sm.is('destroyed'));
	});

	test('can() reflects the declared transitions', () => {
		const sm = make('open');
		assert.ok(sm.can('draining'));
		assert.ok(sm.can('destroyed'));
		assert.ok(!sm.can('pending'), 'open → pending is not declared');
	});

	test('can() permits a same-state no-op', () => {
		assert.ok(make('open').can('open'));
	});

	test('to() performs a declared transition and returns true', () => {
		const sm = make('pending');
		assert.equal(sm.to('open'), true);
		assert.equal(sm.state, 'open');
	});

	test('to() runs onTransition once with (from, to)', () => {
		const onT = mock.fn((_from: S, _to: S) => { /* */ });
		const sm = make('open', onT);
		sm.to('draining');
		assert.equal(onT.mock.callCount(), 1);
		assert.deepEqual(onT.mock.calls[0]?.arguments, ['open', 'draining']);
	});

	test('onTransition observes the already-mutated state (state changes first)', () => {
		const observed: S[] = [];
		const sm: StateMachine<S> = make('open', () => observed.push(sm.state));
		sm.to('draining');
		assert.deepEqual(observed, ['draining'], 'state already changed before the seam ran');
	});

	test('to() treats a same-state call as a no-op: returns false, no onTransition, no throw', () => {
		const onT = mock.fn((_from: S, _to: S) => { /* */ });
		const sm = make('open', onT);
		assert.equal(sm.to('open'), false);
		assert.equal(sm.state, 'open');
		assert.equal(onT.mock.callCount(), 0);
	});

	test('to() throws a loud neutral assertion for a transition absent from the table', () => {
		const onT = mock.fn((_from: S, _to: S) => { /* */ });
		const sm = make('open', onT);
		assert.throws(() => sm.to('pending'), /illegal state transition: open → pending/);
		assert.equal(sm.state, 'open', 'state unchanged after an illegal transition');
		assert.equal(onT.mock.callCount(), 0, 'no side-effects on an illegal transition');
	});

	test('non-linear: a terminal is reachable from several states', () => {
		assert.ok(make('pending').can('destroyed'));
		assert.ok(make('open').can('destroyed'));
		assert.ok(make('draining').can('destroyed'));
		const sm = make('open');
		sm.to('destroyed');
		assert.equal(sm.state, 'destroyed');
	});

	test('onTransition is optional', () => {
		const sm = make('pending');
		assert.doesNotThrow(() => sm.to('open'));
	});
});
