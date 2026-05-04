// Integration-test helper for `@tediousjs/mssql-tedious`.
//
// Integration tests live in `*.int.ts` files and run via `npm run test:int`.
// They require a real SQL Server reachable via env-var-configured connection
// details. Tests skip cleanly (rather than fail) when the env vars are not
// set, so a developer running `npm run test:int` against an empty environment
// gets informative skips, not a noisy failure.
//
// Configure via:
//   MSSQL_TEST_HOST       (default: localhost)
//   MSSQL_TEST_PORT       (default: 1433)
//   MSSQL_TEST_USER       (default: sa)
//   MSSQL_TEST_PASSWORD   (required — no default)
//   MSSQL_TEST_DATABASE   (default: master)
//
// The repo root has a `docker-compose.yml` that spins up a local SQL Server
// matching these defaults.

export interface IntegrationConfig {
	readonly host: string
	readonly port: number
	readonly user: string
	readonly password: string
	readonly database: string
}

export const integrationConfig: IntegrationConfig | null = (() => {
	const password = process.env.MSSQL_TEST_PASSWORD;
	if (password === undefined || password.length === 0) return null;
	return {
		host: process.env.MSSQL_TEST_HOST ?? 'localhost',
		port: Number(process.env.MSSQL_TEST_PORT ?? 1433),
		user: process.env.MSSQL_TEST_USER ?? 'sa',
		password,
		database: process.env.MSSQL_TEST_DATABASE ?? 'master',
	};
})();

// Reason string for skipping integration tests when env vars are absent.
// Surfaced via the `skip` option on `node:test`'s `test()` so the runner
// reports a clear message instead of silently passing.
export const SKIP_REASON =
	'integration tests skipped: set MSSQL_TEST_PASSWORD (and optionally MSSQL_TEST_HOST / MSSQL_TEST_PORT / MSSQL_TEST_USER / MSSQL_TEST_DATABASE) to enable';
