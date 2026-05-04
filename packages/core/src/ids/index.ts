// PROCESS_TAG: 5 random bytes (10 hex characters), generated once per
// process. 40 bits of entropy gives a birthday-collision 50% threshold
// at ~1M concurrent processes — well beyond any realistic deployment
// scale — while keeping the tag log-friendly. WebCrypto
// (globalThis.crypto) works across Node, Deno, Bun, and edge runtimes
// without a node:crypto shim — see ADR-0003 / ADR-0016.
const tagBuffer = new Uint8Array(5);
globalThis.crypto.getRandomValues(tagBuffer);
export const PROCESS_TAG: string = Array.from(tagBuffer, (b) =>
	b.toString(16).padStart(2, '0'),
).join('');

export const ID_PREFIXES = ['conn', 'pool', 'req', 'tx', 'sp', 'prep', 'bulk'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export type IdGenerator = (prefix: string, counter: number) => string;

export const defaultIdGenerator: IdGenerator = (prefix, counter) =>
	`${prefix}_${PROCESS_TAG}_${counter}`;

// Per-prefix counter, shared across all clients in the same process
// so multi-client setups still produce globally monotonic ids for
// correlation.
const counters = new Map<string, number>();

export function nextId(
	prefix: IdPrefix,
	generator: IdGenerator = defaultIdGenerator,
): string {
	const n = (counters.get(prefix) ?? 0) + 1;
	counters.set(prefix, n);
	return generator(prefix, n);
}

/**
 * A savepoint name (`sp_<process-tag>_<counter>`). Unlike {@link nextId},
 * this **always** uses {@link defaultIdGenerator} and is **not** subject
 * to a `createClient({ idGenerator })` override (ADR-0016).
 *
 * Savepoint names are *wire identifiers* — they travel to SQL Server in
 * the TDS Transaction Manager request and must be valid savepoint
 * identifiers (≤32 characters, identifier charset). A custom id
 * generator's output is unconstrained, so routing a wire identifier
 * through it could produce a name SQL Server rejects (or one too long
 * for the protocol's length prefix). Keeping savepoint names on the
 * fixed default format makes them SQL-safe by construction — a wire
 * identifier is a different concern from a correlation id, even though
 * both are `sp`-prefixed and shaped alike. The driver still validates
 * defensively at the wire boundary.
 */
export function savepointName(): string {
	return nextId('sp', defaultIdGenerator);
}
