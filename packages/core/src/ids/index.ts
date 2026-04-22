// PROCESS_TAG: 4 random bytes, hex-encoded, generated once per process.
// WebCrypto (globalThis.crypto) works across Node, Deno, Bun, and edge
// runtimes without a node:crypto shim — see ADR-0003 / ADR-0016.
const tagBuffer = new Uint8Array(4)
globalThis.crypto.getRandomValues(tagBuffer)
export const PROCESS_TAG: string = Array.from(tagBuffer, (b) =>
	b.toString(16).padStart(2, '0'),
).join('')

export const ID_PREFIXES = ['conn', 'pool', 'req', 'tx', 'sp', 'prep', 'bulk'] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]

export type IdGenerator = (prefix: string, counter: number) => string

export const defaultIdGenerator: IdGenerator = (prefix, counter) =>
	`${prefix}_${PROCESS_TAG}_${counter}`

// Per-prefix counter, shared across all clients in the same process
// so multi-client setups still produce globally monotonic ids for
// correlation.
const counters = new Map<string, number>()

export function nextId(
	prefix: IdPrefix,
	generator: IdGenerator = defaultIdGenerator,
): string {
	const n = (counters.get(prefix) ?? 0) + 1
	counters.set(prefix, n)
	return generator(prefix, n)
}
