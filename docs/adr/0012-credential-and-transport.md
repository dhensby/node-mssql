# ADR-0012: Credential and Transport — shared configuration shapes across drivers

- **Status:** Proposed
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

interface Transport {
  host: string
  port?: number
  database?: string
  instance?: string                          // named instance via SQL Browser
  encrypt?: boolean | EncryptOptions
  serverCertificate?: string | Uint8Array    // PEM string or DER bytes
  trustServerCertificate?: boolean
  appName?: string
  native?: unknown                           // driver-specific escape hatch
}

interface EncryptOptions {
  strict?: boolean                           // TDS 8.0 strict pre-login encryption
}
```

`serverCertificate` is typed as `Uint8Array` rather than `Buffer` so the same value passes unchanged on every runtime [ADR-0003](0003-runtime-targets.md) targets — Node's `Buffer extends Uint8Array`, so Node callers can still pass a `Buffer` directly; Deno / Bun / edge callers get a type that actually exists in their runtime.

`EncryptOptions` is intentionally minimal: `strict` is the one knob both tedious and msnodesqlv8 expose uniformly (TDS 8.0 mode / `Encrypt=strict`). Richer TLS configuration (cipher suites, min/max TLS version, custom CA roots, SNI overrides) lives in `Transport.native` today rather than being lifted into the portable surface. The threshold for promoting a knob onto `EncryptOptions` is "both drivers support it and users reach for it routinely" — neither condition is currently met for the rest. Additive fields remain backwards-compatible.

Timeouts deliberately do not live on `Transport`. The single client-level `defaultTimeout` from [ADR-0013](0013-cancellation-and-timeouts.md) covers pool acquire, TDS login, and first-byte wait as one combined budget; per-call deadlines use `.signal(AbortSignal.timeout(…))`. Having driver-specific transport timeouts alongside would reintroduce exactly the two-mental-models problem ADR-0013 was written to avoid. Driver-internal handshake knobs that are genuinely unique to a driver (tedious's `options.connectTimeout` for a background maintenance connection, etc.) go through `transport.native`.

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

Drivers call `provider()` on each connection open and on token refresh (timing is driver-specific). Core does not cache tokens — the user's provider is the source of truth.

**Capability mismatches** are documented, not papered over. `{ kind: 'integrated' }` on tedious at launch throws a `CredentialError` with a message pointing at msnodesqlv8. If tedious adds Windows SSPI support later, the driver starts accepting it; no API change.

**Escape hatches** exist for both types — `Credential.driverNative.config` for truly odd auth flows, `Transport.native` for driver-specific knobs (e.g. tedious's `options.rowCollectionOnDone`). Normal use never touches them. The names signal intent: reaching for `driverNative` or `native` is a flag to reviewers that the user is stepping outside the portable contract.

## Consequences

- Users write portable config. Switching `driver: tedious()` to `driver: msnodesqlv8()` rarely requires any change beyond that line.
- Connection strings ([ADR-0015](0015-connection-strings.md)) parse into these types, not into driver-native shapes. The string dialect is unified at the type level regardless of driver.
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
- [ADR-0013: Cancellation and timeouts](0013-cancellation-and-timeouts.md) — defines the single client-level `defaultTimeout` that replaces per-transport timeout knobs.
- [ADR-0015: Connection string parsing](0015-connection-strings.md) — the string form that deserialises to these types.
- [@azure/identity](https://www.npmjs.com/package/@azure/identity) — the canonical token provider wiring target.
