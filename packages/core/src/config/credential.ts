export type Credential =
	| PasswordCredential
	| IntegratedCredential
	| AccessTokenCredential
	| TokenProviderCredential
	| DriverNativeCredential;

export interface PasswordCredential {
	kind: 'password'
	userName: string
	password: string
}

// Windows SSPI. Supported by msnodesqlv8; tedious driver rejects at
// `open()` time with a CredentialError until upstream support lands.
export interface IntegratedCredential {
	kind: 'integrated'
}

// Pre-fetched bearer token — caller owns refresh.
export interface AccessTokenCredential {
	kind: 'accessToken'
	token: string
}

// Drivers MUST call `provider()` at exactly two points: on
// `Connection.open()` (initial login token), and on a server-initiated
// re-auth event (TDS FedAuth re-auth flow). Drivers MUST NOT
// preemptively refresh tokens on their own timer — caching, refresh
// cadence, and "refresh N minutes before expiry" policy are the user's
// `provider()`'s responsibility (typically delegated to
// `@azure/identity`). Core never caches; the provider is the source of
// truth. Kept as a function rather than an `@azure/identity`-shaped
// object so core stays dependency-free.
export interface TokenProviderCredential {
	kind: 'tokenProvider'
	provider: () => Promise<string>
}

// Escape hatch for driver-specific auth flows that don't fit the
// portable shapes. Reaching for this is a flag to reviewers that the
// config is stepping outside the cross-driver contract.
export interface DriverNativeCredential {
	kind: 'driverNative'
	config: unknown
}
