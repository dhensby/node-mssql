# ADR-0012: Credential and Transport — shared configuration shapes across drivers

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** @dhensby

## Context

v12's `options.authentication.type` mixes driver-specific shapes into what looks like a unified config. Integrated auth only works on msnodesqlv8 but is named at the config level as if it were generic. Entra / Azure AD tokens require juggling `authentication.type: 'azure-active-directory-*'` variants, each with different fields. Users routinely end up reading the v12 source to figure out which auth type supports which driver.

A rewrite that takes hexagonal architecture seriously needs to separate the *portable description* of a credential or transport from the *driver-native encoding* of that description. Users should be able to write one config and have it work with either driver, with well-documented exceptions for capabilities that are genuinely driver-specific (Windows integrated auth, for instance).

## Decision

Core defines two types that both drivers translate:

```ts
type Credential =
  | { kind: 'password'; userName: string; password: string }
  | { kind: 'integrated' }                                      // Windows SSPI
  | { kind: 'accessToken'; token: string }                      // pre-fetched bearer
  | { kind: 'tokenProvider'; provider: () => Promise<string> }  // e.g. @azure/identity
  | { kind: 'driverNative'; config: unknown }                   // escape hatch

interface Transport<N = unknown> {
  host: string
  port?: number
  database?: string
  instance?: string                            // named instance via SQL Browser
  encrypt?: boolean | EncryptOptions
  serverCertificate?: string | Uint8Array      // PEM string or DER bytes
  trustServerCertificate?: boolean
  appName?: string                             // sent in login as Application Name
  workstationId?: string                       // sent in login as Workstation ID (client identifier)
  applicationIntent?: 'readOnly' | 'readWrite' // AG read-replica routing
  multiSubnetFailover?: boolean                // AG / Azure SQL multi-subnet failover behaviour
  packetSize?: number                          // TDS packet size in bytes
  native?: N                                   // driver-specific escape hatch
}

interface EncryptOptions {
  strict?: boolean                           // TDS 8.0 strict pre-login encryption
}
```

The portable shape covers the network-and-login-time keywords from the .NET `SqlConnection` connection-string vocabulary that both first-party drivers (tedious, msnodesqlv8) honour: `Data Source` / `Server` (split into `host` + `instance`, with `port` separated for clarity), `Initial Catalog` (`database`), `Encrypt` / `TrustServerCertificate`, `Application Name` (`appName`), `Workstation ID` (`workstationId`), `ApplicationIntent` (`applicationIntent`), `MultiSubnetFailover` (`multiSubnetFailover`), and `Packet Size` (`packetSize`). Credential-related keywords (User ID, Password, Authentication, Trusted_Connection) live in `Credential`; pool-related keywords (Min/Max Pool Size, Pooling, Connection Lifetime) live in `PoolOptions` ([ADR-0011](0011-pool-port.md)); `Connection Timeout` is the kernel's `defaultTimeout`. Anything outside this portable surface — `Failover Partner`, `User Instance`, `AttachDBFilename`, `Network Library`, `ColumnEncryptionSetting`, `Type System Version`, etc. — goes through `transport.native` if the user needs it.

`serverCertificate` is typed as `Uint8Array` rather than `Buffer` so the same value passes unchanged on every runtime [ADR-0003](0003-runtime-targets.md) targets — Node's `Buffer extends Uint8Array`, so Node callers can still pass a `Buffer` directly; Deno / Bun / edge callers get a type that actually exists in their runtime.

`EncryptOptions` is intentionally minimal: `strict` is the one knob both tedious and msnodesqlv8 expose uniformly (TDS 8.0 mode / `Encrypt=strict`). Richer TLS configuration (cipher suites, min/max TLS version, custom CA roots, SNI overrides) lives in `Transport.native` today rather than being lifted into the portable surface. The threshold for promoting a knob onto `EncryptOptions` is "both drivers support it and users reach for it routinely" — neither condition is currently met for the rest. Additive fields remain backwards-compatible.

Timeouts deliberately do not live on `Transport`. A single client-level `defaultTimeout` covers pool acquire, TDS login, and first-byte wait as one combined budget; per-call deadlines use `.signal(AbortSignal.timeout(…))`. Having driver-specific transport timeouts alongside would reintroduce exactly the two-mental-models problem the unified timeout was written to avoid. Driver-internal handshake knobs that are genuinely unique to a driver (tedious's `options.connectTimeout` for a background maintenance connection, etc.) go through `transport.native`.

Drivers translate these to their native shapes inside `open()` ([ADR-0010](0010-driver-port.md)):

- `tedious` maps `{ kind: 'password' }` to its `authentication.type: 'default'`, `{ kind: 'accessToken' }` to `'azure-active-directory-access-token'`, etc.
- `msnodesqlv8` maps `{ kind: 'password' }` to a SQL Server Authentication ODBC string, `{ kind: 'integrated' }` to `Trusted_Connection=Yes`, and so on.

`tokenProvider` is intentionally a function, not a provider object. This keeps core free of any dependency on `@azure/identity` or similar — users wire it themselves:

```ts
import { DefaultAzureCredential } from '@azure/identity'
const cred = new DefaultAzureCredential()
createClient({
  driver: tedious(),
  credential: {
    kind: 'tokenProvider',
    provider: async () => (await cred.getToken('https://database.windows.net/')).token,
  },
})
```

Drivers MUST call `provider()` at exactly two points in the lifecycle:

1. **On `Connection.open()`** — once, to obtain the initial bearer token for login.
2. **On a server-initiated re-auth event** — when the SQL Server endpoint signals that the current token is expiring or has been revoked and requests a fresh one (TDS's FedAuth re-auth flow).

Drivers MUST NOT preemptively refresh tokens on their own timer. Token caching, refresh cadence, and "refresh N minutes before expiry" policy are the user's `provider()`'s responsibility — typically delegated to `@azure/identity` or whichever identity library the user wired up, which already implements those concerns. A driver that runs its own refresh timer would double up against the provider's caching, contend on the token endpoint (rate-limit risk against IMDS in particular), and potentially produce stale tokens at the boundary between the two cadences.

Core does not cache tokens at all — the user's provider is the source of truth, and drivers call it only when the protocol genuinely needs a token (initial auth or server-told re-auth).

**Capability mismatches** are documented, not papered over. `{ kind: 'integrated' }` on tedious at launch throws a `CredentialError` with a message pointing at msnodesqlv8. If tedious adds Windows SSPI support later, the driver starts accepting it; no API change.

**Escape hatches** exist for both types — `Credential.driverNative.config` for truly odd auth flows, `Transport.native` for driver-specific knobs (e.g. tedious's `options.rowCollectionOnDone`). Normal use never touches them. The names signal intent: reaching for `driverNative` or `native` is a flag to reviewers that the user is stepping outside the portable contract.

## Consequences

- Users write portable config. Switching `driver: tedious()` to `driver: msnodesqlv8()` rarely requires any change beyond that line.
- Connection strings parse into these types, not into driver-native shapes. The string dialect is unified at the type level regardless of driver.
- `@azure/identity` is a peer concern — core never imports it, never depends on it, never pins a version. Users pick their own token source.
- Capability mismatches are explicit runtime errors, not silent fallbacks. This is better than v12's current behaviour of accepting configs that then fail in subtle ways later.
- A new driver landing `integrated` support means adding acceptance in that driver's `open()` — no type changes, no API changes, no coordination with core.

## Alternatives considered

**Union of driver-specific credential shapes.** Rejected — this is v12's current approach and the source of the ergonomic pain. It forces users to know the driver before writing the config.

**Require users to pass driver-native options directly.** Rejected — it works but makes `mssql-core` a thin façade with no shared vocabulary. Portability across drivers is a headline feature.

**Bake `@azure/identity` into core as a first-class credential source.** Considered. Rejected because it pins a version on every user, brings a transitive dependency surface we do not control, and forecloses on other cloud providers' identity libraries. The `tokenProvider` shape is the right level of abstraction: a function that returns a string.

**Include `domain` on `{ kind: 'integrated' }` for kerberos.** Rejected for the first cut. If the need arises, extend the shape — the tagged union makes that backwards-compatible.

## References

- [ADR-0010: Driver port](0010-driver-port.md) — the consumer of these types.
- [@azure/identity](https://www.npmjs.com/package/@azure/identity) — the canonical token provider wiring target.
- [.NET `SqlConnection.ConnectionString`](https://learn.microsoft.com/en-us/dotnet/api/system.data.sqlclient.sqlconnection.connectionstring) — canonical SQL Server connection-string keyword vocabulary; `Transport`'s portable subset is the network-and-login-time keywords from that table.
