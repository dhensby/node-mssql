/**
 * Translate tedious's native errors into core's `MssqlError` taxonomy
 * (ADR-0017). This is the driver-port boundary's translation
 * responsibility (ADR-0010): no `tedious` `RequestError` / `ConnectionError`
 * escapes the driver — every failure surfaces as an `MssqlError` subclass
 * with the native error preserved on `.cause`.
 *
 * Classification is by tedious error *type*, with the calling operation
 * choosing the entry point:
 *
 * - {@link mapQueryError} — `execute` / `ping`: a server `RequestError`
 *   (has `.number`) becomes a `QueryError` / `ConstraintError`; a
 *   connection-level failure becomes a `ConnectionError`.
 * - {@link mapConnectError} — `open` / `reset`: connection-level →
 *   `ConnectionError` / `CredentialError`.
 * - {@link mapTransactionError} — `beginTransaction` / `commit` /
 *   `rollback` / `savepoint` / `rollbackToSavepoint`: → `TransactionError`,
 *   unless the connection itself died (→ `ConnectionError`).
 *
 * Anything unrecognised falls back to `DriverError` — the wrapper of last
 * resort (ADR-0017); its rate is a driver-quality signal.
 *
 * Signal-aborts are NOT this module's concern: the kernel owns
 * `AbortError` / `TimeoutError` and the `phase` stamp (ADR-0013 / ADR-0017),
 * so callers rethrow an abort before reaching here rather than letting it
 * be misclassified as a `DriverError`.
 *
 * Internal helper — not part of the public surface of
 * `@tediousjs/mssql-tedious`.
 */

import { ConnectionError as TediousConnectionError, RequestError } from 'tedious';
import {
	ConnectionError,
	ConstraintError,
	constraintKindFromNumber,
	CredentialError,
	DriverError,
	type MssqlError,
	QueryError,
	TransactionError,
} from '@tediousjs/mssql-core';

/** Context the driver stamps onto every error it produces (ADR-0016). */
export interface ErrorContext {
	connectionId?: string
}

// tedious connection-level error codes — failures about the socket /
// session, not a server-rejected statement. A `RequestError` carrying one
// of these (rather than a server error `.number`) is a connection drop
// mid-request, not a query rejection.
const CONNECTION_CODES: ReadonlySet<string> = new Set([
	'ESOCKET',
	'ECONNRESET',
	'ETIMEOUT',
	'EINSTLOOKUP',
	'ENOTOPEN',
	'ENOCONN',
	'ECLOSE',
	'ELOGIN',
]);

// T-SQL login-failure number; surfaces alongside tedious's `ELOGIN` code.
const LOGIN_FAILED = 18456;

const messageOf = (err: unknown): string =>
	err instanceof Error && err.message.length > 0 ? err.message : String(err);

const codeOf = (err: unknown): string | undefined =>
	typeof err === 'object' && err !== null && 'code' in err
		? (err as { code?: unknown }).code as string | undefined
		: undefined;

// Best-effort constraint name from a SQL Server violation message. The
// name follows "constraint" in quotes — single for UNIQUE / PK
// (`constraint 'UQ_x'`), double for FK / CHECK (`constraint "FK_x"`) — or
// "index" for a duplicate-key unique-index violation (2601:
// `unique index 'IX_x'`). NOT NULL violations (515) name a column, not a
// constraint, so this returns `undefined` for them — the user still has
// `.number` and `.message`.
const parseConstraintName = (message: string): string | undefined => {
	const m = /(?:constraint|index)\s+["']([^"']+)["']/i.exec(message);
	return m?.[1];
};

const isAuthFailure = (err: unknown): boolean =>
	codeOf(err) === 'ELOGIN' ||
	(err instanceof RequestError && err.number === LOGIN_FAILED);

// A connection-level failure (or anything we're treating as one) →
// `ConnectionError`, narrowing to `CredentialError` for auth failures.
const fromConnectionError = (err: unknown, ctx: ErrorContext): ConnectionError =>
	isAuthFailure(err)
		? new CredentialError(messageOf(err), { ...ctx, cause: err })
		: new ConnectionError(messageOf(err), { ...ctx, cause: err });

// A server `RequestError` (TDS error token) → `QueryError`, narrowing to
// `ConstraintError` when the number maps to a constraint kind.
const fromRequestError = (err: RequestError, ctx: ErrorContext): QueryError => {
	const number = err.number ?? 0;
	const base = {
		...ctx,
		cause: err,
		number,
		state: err.state ?? 0,
		severity: err.class ?? 0,
		...(err.serverName !== undefined ? { serverName: err.serverName } : {}),
		...(err.procName !== undefined ? { procName: err.procName } : {}),
		...(err.lineNumber !== undefined ? { lineNumber: err.lineNumber } : {}),
	};
	const kind = constraintKindFromNumber(number, err.message);
	if (kind !== undefined) {
		const constraintName = parseConstraintName(err.message);
		return new ConstraintError(err.message, {
			...base,
			kind,
			...(constraintName !== undefined ? { constraintName } : {}),
		});
	}
	return new QueryError(err.message, base);
};

// True for tedious errors that are connection-level rather than a
// server-rejected statement: a `ConnectionError`, or a `RequestError`
// without a server `.number` but carrying a connection-level `.code`
// (a mid-request connection drop).
const isConnectionLevel = (err: unknown): boolean => {
	if (err instanceof TediousConnectionError) return true;
	if (err instanceof RequestError && typeof err.number !== 'number') {
		const code = codeOf(err);
		return code !== undefined && CONNECTION_CODES.has(code);
	}
	return false;
};

/**
 * `execute` / `ping`: a server statement rejection → `QueryError` /
 * `ConstraintError`; a connection-level failure → `ConnectionError`;
 * anything else → `DriverError`.
 */
export function mapQueryError(err: unknown, ctx: ErrorContext = {}): MssqlError {
	if (err instanceof RequestError && typeof err.number === 'number') {
		return fromRequestError(err, ctx);
	}
	if (isConnectionLevel(err)) return fromConnectionError(err, ctx);
	return new DriverError(messageOf(err), { ...ctx, cause: err });
}

/**
 * `open` / `reset`: connection-level failure → `ConnectionError` /
 * `CredentialError`; anything else → `DriverError`.
 */
export function mapConnectError(err: unknown, ctx: ErrorContext = {}): MssqlError {
	if (err instanceof TediousConnectionError || err instanceof RequestError) {
		return fromConnectionError(err, ctx);
	}
	return new DriverError(messageOf(err), { ...ctx, cause: err });
}

/**
 * Transaction control ops: → `TransactionError`, unless the connection
 * itself died (→ `ConnectionError`). The TDS error number, when there is
 * one, is preserved on `.cause`.
 */
export function mapTransactionError(err: unknown, ctx: ErrorContext = {}): MssqlError {
	if (isConnectionLevel(err)) return fromConnectionError(err, ctx);
	return new TransactionError(messageOf(err), { ...ctx, cause: err });
}
