// `@tediousjs/mssql-tedious` — tedious driver adapter for `@tediousjs/mssql-core`.
//
// Vertical-slice surface (V-3): `tediousDriver()` — the factory the user
// passes to `createClient({ driver: tediousDriver(), ... })`. The
// internal helpers (TediousConnectionWrapper, EventBridge,
// inferParameterType) are not exported — they're implementation
// details. Users compose at the `Driver` boundary defined by core.

export { tediousDriver } from './driver.js';
