/**
 * Diagnostics channel definitions (ADR-0014).
 *
 * The library publishes activity on Node's `diagnostics_channel` —
 * the standard Node-native way to expose library activity to
 * observability tools (OpenTelemetry's `@opentelemetry/instrumentation-*`
 * subscribes to these without the library importing OTEL; `undici`,
 * `node:http`, `node-redis` use the same pattern). No `debug`
 * dependency, no APM SDK.
 *
 * Channel names, namespace, and event payload shapes are defined
 * here in core. Drivers and pool adapters publish on these channels
 * directly for events they're authoritative about (per the table in
 * ADR-0014); coordination is by importing the typed constants from
 * this module, so TypeScript catches drift at compile time —  a
 * driver renaming an event or shipping an off-shape payload is a
 * build failure, not a silent observability bug.
 *
 * R-7 cut — only the `mssql:client:state-change` channel that the
 * Client itself owns. Other channels (`mssql:query`, `mssql:pool:*`,
 * `mssql:connection:*`, `mssql:transaction:*`, …) land in subsequent
 * round-out commits (R-9 picks up the kernel-wide emission pass).
 */

import { channel, type Channel } from 'node:diagnostics_channel';
import type { ClientState } from '../client/state.js';

/**
 * Payload shape for the `mssql:client:state-change` channel.
 *
 * `from` and `to` are the canonical Client state machine
 * (`pending` ↔ `open` ↔ `draining` ↔ `destroyed`). Publishing
 * fires once per transition; same-state publishes do not happen
 * (the Client suppresses no-op transitions).
 *
 * Subscribers use this for readiness probes (flip to 503 on
 * `'draining'` so SIGTERM-shutdown doesn't race new traffic),
 * APM lifecycle timelines, and lifecycle-aware test fixtures,
 * without polling `client.state`.
 */
export interface ClientStateChangePayload {
	readonly from: ClientState
	readonly to: ClientState
}

/**
 * `mssql:client:state-change` — every Client state transition.
 *
 * Strongly-typed wrapper around `diagnostics_channel.channel(...)`.
 * The runtime Channel is identical to one obtained by name; the
 * typing is the only difference. Subscribers can subscribe either
 * via this export (typed) or via `channel('mssql:client:state-change')`
 * (untyped) — the underlying machinery is the same singleton.
 */
export const CLIENT_STATE_CHANGE_CHANNEL = 'mssql:client:state-change' as const;
export const clientStateChangeChannel = channel(CLIENT_STATE_CHANGE_CHANNEL) as Channel<ClientStateChangePayload>;
