/**
 * `ClientConfig` — the shape `createClient(config)` accepts.
 *
 * Round-out cut: wires driver + transport + credential, plus the
 * client-level `defaultIsolationLevel` (ADR-0006) used by every
 * transaction this client opens unless overridden per-call. Other
 * round-out commits add the rest:
 *
 * - `id?: string` (object-id override, ADR-0016)
 * - `defaultTimeout?: number` (acquire + login + first-byte budget, ADR-0013)
 * - `errorOnInfo?: (msg: InfoMessage) => boolean` (promote-to-error, ADR-0007)
 * - other client-level knobs as they're specified
 */

import type { Credential, Transport } from '../config/index.js';
import type { Driver, IsolationLevel } from '../driver/index.js';
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
	/**
	 * Default transaction isolation level for `sql.transaction()` when
	 * the per-call `.isolationLevel(...)` is not specified (ADR-0006).
	 * Falls through to the library default `'read committed'` when
	 * omitted. Per-call override always wins.
	 */
	readonly defaultIsolationLevel?: IsolationLevel
}
