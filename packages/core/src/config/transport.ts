// Encryption knobs shared across drivers. Kept minimal: both tedious
// and msnodesqlv8 support a `strict` TDS 8.0 mode; richer per-driver
// TLS configuration goes through `Transport.native` rather than bloating
// the portable type (ADR-0012 / feedback_design_to_real_drivers).
export interface EncryptOptions {
	strict?: boolean
}

export interface Transport {
	host: string
	port?: number
	database?: string
	// Named instance resolved via SQL Browser (UDP 1434).
	instance?: string
	encrypt?: boolean | EncryptOptions
	serverCertificate?: string | Uint8Array
	trustServerCertificate?: boolean
	appName?: string
	// Driver-specific escape hatch (e.g. tedious's `options.rowCollectionOnDone`).
	// See Credential.driverNative for the auth analogue.
	native?: unknown
}
