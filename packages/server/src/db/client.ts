/**
 * Database client factory and helpers.
 *
 * Uses the porsager `postgres` driver with a configurable connection pool.
 * The Drizzle instance wraps the pool and provides typed queries.
 *
 * Call `createDb(url, poolMax?)` when you need a fresh connection (tests,
 * migration CLI). Call `getDb()` for the process-lifetime singleton.
 */

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getConfig } from '../config/index.js';
import * as schema from './schema.js';

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Drizzle instance backed by a postgres.js pool.
 *
 * @param url      - DATABASE_URL connection string.
 * @param poolMax  - Maximum number of pool connections (default 10).
 *
 * Returns both the raw postgres.js client (for lifecycle management) and the
 * Drizzle wrapper (for queries and transactions).
 */
export function createDb(url: string, poolMax = 10): { sql: postgres.Sql; db: DrizzleDb } {
  const sql = postgres(url, {
    max: poolMax,
  });

  const db = drizzle(sql, { schema });

  return { sql, db };
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a database transaction.
 * If `fn` throws, the transaction is rolled back and the error re-thrown.
 */
export async function withTransaction<T>(
  db: DrizzleDb,
  fn: (tx: DrizzleDb) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

// ---------------------------------------------------------------------------
// Process-lifetime singleton
// ---------------------------------------------------------------------------

let _instance: { sql: postgres.Sql; db: DrizzleDb } | undefined;

function getInstance(): { sql: postgres.Sql; db: DrizzleDb } {
  if (_instance === undefined) {
    const cfg = getConfig();
    _instance = createDb(cfg.DATABASE_URL, cfg.DATABASE_POOL_MAX);
  }
  return _instance;
}

/**
 * Returns the process-lifetime database singleton.
 * Reads DATABASE_URL and DATABASE_POOL_MAX from the env config on first call.
 */
export function getDb(): DrizzleDb {
  return getInstance().db;
}

/**
 * Close the singleton connection pool. Useful for graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  if (_instance !== undefined) {
    await _instance.sql.end();
    _instance = undefined;
  }
}

/**
 * Reset the singleton for tests that need a fresh connection.
 * Properly closes the pool to avoid event-loop leaks.
 * @internal
 */
export async function _resetDbForTest(): Promise<void> {
  if (_instance !== undefined) {
    await _instance.sql.end();
    _instance = undefined;
  }
}
