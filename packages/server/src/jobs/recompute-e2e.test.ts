/**
 * End-to-end recompute pipeline test: POST /recompute → worker processes → status='succeeded'.
 *
 * Phase 13b review (C-Quality-2):
 *   - An ingested submission exists (flags from ingest pipeline).
 *   - POST /recompute against the active config triggers recompute_semester.
 *   - Worker processes recompute_submission jobs.
 *   - recompute_jobs.status reaches 'succeeded'.
 *   - All non-superseded submissions have recompute_status='fresh'.
 *
 * Mirrors the ingest-e2e.test.ts pattern: real pg-boss + testcontainers,
 * no mocks.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { withTestMinio } from '../../test/helpers/minio.js';
import { _setConfigForTest, _resetConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { _resetDbForTest } from '../db/client.js';
import { _resetBossForTest } from './pg-boss.js';
import { parseEnv } from '../config/env.js';
import { createV1App } from '../api/v1/index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  ingest_jobs,
  ingest_files,
  submissions,
  heuristic_configs,
  recompute_jobs,
} from '../db/schema.js';
import * as schema from '../db/schema.js';
import { startWorker } from './worker.js';
import { buildTestBundle } from '@provenance/analyzer/test/helpers/build-test-bundle.js';
import type { DrizzleDb } from '../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

// ---------------------------------------------------------------------------
// Helper: build a real bundle ZIP
// ---------------------------------------------------------------------------

async function makeRealBundleBytes(opts: { assignmentId: string; semester: string }): Promise<{
  bytes: Uint8Array;
}> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: opts.assignmentId,
    semester: opts.semester,
    sessions: [{ eventCount: 3 }],
  });
  return { bytes: new Uint8Array(zipBuffer) };
}

// ---------------------------------------------------------------------------
// Test: one Postgres container per test for isolation.
// ---------------------------------------------------------------------------

describe('recompute e2e pipeline (POST /recompute → worker → status=succeeded)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let dbSql: postgres.Sql;
  let db: DrizzleDb;
  let workerStop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const connectionString = pgContainer.getConnectionUri();
    dbSql = postgres(connectionString, { max: 5 });
    db = drizzle(dbSql, { schema }) as DrizzleDb;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
  });

  afterEach(async () => {
    if (workerStop !== null) {
      await workerStop();
      workerStop = null;
    }
    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
    await dbSql.end();
    await pgContainer.stop();
  });

  it('recomputes ingested submission to succeeded with recompute_status=fresh', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      const connectionString = pgContainer.getConnectionUri();
      const minioEndpoint = client.bucketUrl.replace(`/${bucketName}`, '');

      _setConfigForTest(
        parseEnv({
          NODE_ENV: 'test',
          PUBLIC_BASE_URL: 'http://localhost:3000',
          DATABASE_URL: connectionString,
          OBJECT_STORAGE_ENDPOINT: minioEndpoint,
          OBJECT_STORAGE_BUCKET: bucketName,
          OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
          OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
          OBJECT_STORAGE_REGION: 'us-east-1',
          GOOGLE_OAUTH_CLIENT_ID: 'client-id',
          GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
          AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
          AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
          AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-recompute-e2e-1234567',
          SESSION_TTL_DAYS: '14',
          INGEST_MAX_BUNDLE_BYTES: '52428800',
          INGEST_MAX_BATCH_BYTES: '5368709120',
          INGEST_MAX_BATCH_FILES: '10000',
        }),
      );

      // Seed domain data.
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        google_subject: `sub-${userId}`,
        email: `admin-${userId}@berkeley.edu`,
        display_name: 'Admin',
        is_superadmin: false,
      });

      const sessionToken = `sess-${'x'.repeat(37)}`.slice(0, 43);
      await db.insert(sessions).values({
        id: sessionToken,
        user_id: userId,
        expires_at: new Date(Date.now() + 14 * 86400_000),
      });

      const courseSlug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
      const [course] = await db
        .insert(courses)
        .values({ name: 'CS 61A', slug: courseSlug })
        .returning();

      const [semester] = await db
        .insert(semesters)
        .values({
          course_id: course!.id,
          term: 'fa',
          year: 2024,
          slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
          display_name: 'Fall 2024',
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();

      await db.insert(memberships).values({
        user_id: userId,
        semester_id: semester!.id,
        role: 'admin',
        granted_by: userId,
      });

      await db.insert(roster_entries).values({
        semester_id: semester!.id,
        sid: '123456',
        display_name: 'Test Student',
      });

      // Insert a heuristic_configs row (active v1) so createRecomputeJob can find it.
      const { DEFAULT_SERVER_CONFIG } = await import('../services/heuristics/config.js');
      const [configRow] = await db
        .insert(heuristic_configs)
        .values({
          semester_id: semester!.id,
          version: 1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb
          config: DEFAULT_SERVER_CONFIG as any,
          set_by: userId,
          is_active: true,
          note: 'e2e test config',
        })
        .returning();

      // Build + ingest a real bundle so there's a submission with events+flags.
      const { bytes: bundleBytes } = await makeRealBundleBytes({
        assignmentId: 'hw01',
        semester: 'fa2024',
      });
      const filename = 'hw01-123456.zip';

      // Start the worker.
      workerStop = await startWorker();

      // POST /ingest
      const app = createV1App();
      const formData = new FormData();
      formData.append(
        'files[]',
        new Blob([bundleBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        filename,
      );

      const ingestRes = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/ingest`, {
          method: 'POST',
          headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          body: formData,
        }),
      );
      expect(ingestRes.status).toBe(202);
      const { job_id: ingestJobId } = (await ingestRes.json()) as { job_id: string };

      // Wait for ingest to finish.
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 90_000;
      let ingestFinalStatus: string | null = null;
      const ingestStart = Date.now();
      while (Date.now() - ingestStart < POLL_TIMEOUT_MS) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, ingestJobId));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          ingestFinalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      expect(ingestFinalStatus, 'Ingest job must reach terminal status').toBe('succeeded');

      // Verify ingest produced a submission.
      const [fileRow] = await db
        .select({ submission_id: ingest_files.submission_id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, ingestJobId));
      expect(fileRow?.submission_id).toBeTruthy();
      const submissionId = fileRow!.submission_id!;

      // -----------------------------------------------------------------------
      // POST /recompute against the active config.
      // -----------------------------------------------------------------------
      const recomputeRes = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/recompute`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-prov_sess=${sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ note: 'e2e recompute test' }),
        }),
      );
      expect(recomputeRes.status).toBe(200);
      const recomputeBody = (await recomputeRes.json()) as {
        recompute_job: { id: string; status: string };
      };
      const recomputeJobId = recomputeBody.recompute_job.id;
      expect(recomputeJobId).toBeTruthy();

      // Poll GET /recompute/:jobId until terminal.
      let recomputeFinalStatus: string | null = null;
      const recomputeStart = Date.now();
      while (Date.now() - recomputeStart < POLL_TIMEOUT_MS) {
        const getRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/recompute/${recomputeJobId}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          }),
        );
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as {
          status: string;
          progress_done: number;
          progress_total: number;
          progress_failed: number;
        };

        if (getBody.status !== 'queued' && getBody.status !== 'running') {
          recomputeFinalStatus = getBody.status;
          // Assert final progress state.
          expect(getBody.progress_done, 'progress_done must equal progress_total').toBe(
            getBody.progress_total,
          );
          expect(getBody.progress_failed, 'progress_failed must be 0').toBe(0);
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      expect(recomputeFinalStatus, `Recompute job never reached terminal status (timed out)`).toBe(
        'succeeded',
      );

      // Assert all non-superseded submissions have recompute_status='fresh'.
      const subsRows = await db
        .select({ id: submissions.id, recompute_status: submissions.recompute_status })
        .from(submissions)
        .where(and(eq(submissions.semester_id, semester!.id), eq(submissions.id, submissionId)));
      expect(subsRows).toHaveLength(1);
      expect(subsRows[0]!.recompute_status).toBe('fresh');

      // Assert a recompute_jobs row with target_config_id matching the active config.
      const [rjRow] = await db
        .select({ target_config_id: recompute_jobs.target_config_id })
        .from(recompute_jobs)
        .where(eq(recompute_jobs.id, recomputeJobId));
      expect(rjRow!.target_config_id).toBe(configRow!.id);
    });
  });
});
