/**
 * Integration test for the db client factory.
 * Requires Docker (testcontainers).
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';

describe('createDb / withTestDb', () => {
  it('connects and executes SELECT 1', async () => {
    await withTestDb(async (db) => {
      const result = await db.execute(sql`SELECT 1 AS val`);
      // postgres.js returns an array of row objects.
      const rows = result as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBeDefined();
      expect(rows[0]!['val']).toBe(1);
    });
  });
});
