/**
 * `ClientConfig` — the shape `createClient(config)` accepts.
 *
 * Vertical-slice cut: just enough to wire driver + transport + credential
 * through a pool factory. Round-out commits add the rest from
 * ADR-0006 / ADR-0013 / ADR-0007 / ADR-0018:
 *
 * - `id?: string` (object-id override, ADR-0016)
 * - `defaultTimeout?: number` (acquire + login + first-byte budget, ADR-0013)
 * - `defaultIsolationLevel?: IsolationLevel` (per-tx default, ADR-0006)
 * - `errorOnInfo?: (msg: InfoMessage) => boolean` (promote-to-error, ADR-0007)
 * - other client-level knobs as they're specified
 */

import type { Credential, Transport } from '../config/index.js';
import type { Driver } from '../driver/index.js';
import type { PoolFactory, PoolHooks } from '../pool/index.js';

export interface ClientConfig {
	readonly driver: Driver
	readonly credential: Credential
	readonly transport: Transport
	// Defaults to `singleConnection()` (the no-pool short-circuit) when
	// omitted, per ADR-0011. Long-running services should reach for tarn
	// or another adapter explicitly.
	readonly pool?: PoolFactory
	readonly hooks?: PoolHooks
}
