/**
 * Database migration CLI.
 *
 * Applies all pending migrations from `packages/server/db/migrations/` to the
 * database specified by DATABASE_URL.
 *
 * Usage:
 *   npm run db:migrate --workspace=packages/server
 *
 * Reads DATABASE_URL from the environment (or .env file if tsx auto-loads it).
 * Exits with code 1 on failure.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Migrations are in packages/server/db/migrations/ relative to this file's
// location at packages/server/src/db/migrate.ts → go up two levels.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

async function runMigrations(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('Error: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  console.log('Running migrations from:', MIGRATIONS_DIR);

  // Use max:1 for migration runs — serial execution only.
  const sql = postgres(url, { max: 1 });

  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log('Migrations applied successfully.');
  } finally {
    await sql.end();
  }
}

runMigrations().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
