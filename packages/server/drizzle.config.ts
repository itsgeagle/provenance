import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  // DATABASE_URL is read from the environment when running drizzle-kit commands.
  // For local dev: set it in .env or export it before running npm run db:generate / db:migrate.
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  verbose: true,
  strict: true,
});
