// Encryption knobs shared across drivers. Kept minimal: both tedious
// and msnodesqlv8 support a `strict` TDS 8.0 mode; richer per-driver
// TLS configuration goes through `Transport.native` rather than bloating
// the portable type (ADR-0012 / feedback_design_to_real_drivers).
export interface EncryptOptions {
	strict?: boolean
}

export interface Transport<N = unknown> {
	host: string
	port?: number
	database?: string
	// Named instance resolved via SQL Browser (UDP 1434).
	instance?: string
	encrypt?: boolean | EncryptOptions
	serverCertificate?: string | Uint8Array
	trustServerCertificate?: boolean
	// Sent in the TDS login as Application Name.
	appName?: string
	// Sent in the TDS login as Workstation ID (client identifier).
	workstationId?: string
	// AG read-replica routing.
	applicationIntent?: 'readOnly' | 'readWrite'
	// AG / Azure SQL multi-subnet failover behaviour.
	multiSubnetFailover?: boolean
	// TDS packet size in bytes.
	packetSize?: number
	// Driver-specific escape hatch (e.g. tedious's `options.rowCollectionOnDone`).
	// See Credential.driverNative for the auth analogue.
	native?: N
}
