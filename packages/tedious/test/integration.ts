// Integration-test helper for `@tediousjs/mssql-tedious`.
//
// Integration tests live in `*.int.ts` files and run via `npm run test:int`.
// They require a real SQL Server reachable via env-var-configured connection
// details — there is no silent skip. A missing config is a hard test
// failure with a help message, so "the test suite passes" means
// "the integration tests passed against a real database", not
// "we never tried."
//
// Configure via:
//   MSSQL_TEST_HOST       (default: localhost)
//   MSSQL_TEST_PORT       (default: 1433)
//   MSSQL_TEST_USER       (default: sa)
//   MSSQL_TEST_PASSWORD   (required — no default)
//   MSSQL_TEST_DATABASE   (default: master)
//
// The repo root has a `docker-compose.yml` that spins up a local SQL Server
// matching these defaults. Bring it up with `docker compose up -d` and
// run `MSSQL_TEST_PASSWORD='yourStrong(!)Password' npm run test:int`.

export interface IntegrationConfig {
	readonly host: string
	readonly port: number
	readonly user: string
	readonly password: string
	readonly database: string
}

const HELP = `
Integration tests require a SQL Server reachable via the MSSQL_TEST_* env vars.

Required:
  MSSQL_TEST_PASSWORD   The SQL Server SA password.

Optional (with defaults):
  MSSQL_TEST_HOST       (default: localhost)
  MSSQL_TEST_PORT       (default: 1433)
  MSSQL_TEST_USER       (default: sa)
  MSSQL_TEST_DATABASE   (default: master)

The repo's \`docker-compose.yml\` at the project root provides a working
SA password of \`yourStrong(!)Password\`. To run integration tests:

  docker compose up -d
  MSSQL_TEST_PASSWORD='yourStrong(!)Password' npm run test:int
`.trim();

/**
 * Build an {@link IntegrationConfig} from environment variables, or throw
 * with a helpful message if the required env is missing.
 *
 * Integration tests call this at suite setup so a missing config surfaces
 * as a single loud failure rather than a silent pass — see file header.
 */
export function requireIntegrationConfig(): IntegrationConfig {
	const password = process.env.MSSQL_TEST_PASSWORD;
	if (password === undefined || password.length === 0) {
		throw new Error(`MSSQL_TEST_PASSWORD is not set.\n\n${HELP}`);
	}
	return {
		host: process.env.MSSQL_TEST_HOST ?? 'localhost',
		port: Number(process.env.MSSQL_TEST_PORT ?? 1433),
		user: process.env.MSSQL_TEST_USER ?? 'sa',
		password,
		database: process.env.MSSQL_TEST_DATABASE ?? 'master',
	};
}
