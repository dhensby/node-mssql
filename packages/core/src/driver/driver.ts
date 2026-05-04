import type { Credential, Transport } from '../config/index.js';
import type { Connection } from './connection.js';

export interface DriverOptions {
	readonly credential: Credential
	readonly transport: Transport
	readonly id?: string
}

/**
 * Opaque placeholder for a driver's type coercion registry.
 * Shape is pinned when the first driver adapter lands.
 */
export type TypeRegistry = Readonly<Record<string, unknown>>;

/**
 * Opaque placeholder for a driver's connection-string schema.
 * Shape is pinned by ADR-0015.
 */
export type ConnectionStringSchema = Readonly<Record<string, unknown>>;

export interface Driver {
	readonly name: string
	open(opts: DriverOptions): Promise<Connection>
	readonly connectionStringSchema?: ConnectionStringSchema
	readonly types: TypeRegistry
}
