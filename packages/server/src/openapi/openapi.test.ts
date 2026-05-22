/**
 * OpenAPI spec validation + drift tests (Phase 19).
 *
 * Test groups:
 *   1. Spec structure — valid OpenAPI 3.1 top-level shape
 *   2. Coverage — all PRD §8 routes are present in the spec
 *   3. GET /openapi.json — returns valid JSON spec via HTTP
 *   4. GET /docs — returns HTML with Redoc script tag
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openApiSpec } from './spec/index.js';
import { createApp } from '../api/start.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';

function makeTestEnv() {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-openapi-tests-1234567890123',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// §1. Spec structure
// ---------------------------------------------------------------------------

describe('OpenAPI spec structure', () => {
  it('has top-level openapi version 3.1.x', () => {
    expect(openApiSpec.openapi).toMatch(/^3\.1\./);
  });

  it('has info with title and version', () => {
    expect(typeof openApiSpec.info.title).toBe('string');
    expect(openApiSpec.info.title.length).toBeGreaterThan(0);
    expect(typeof openApiSpec.info.version).toBe('string');
  });

  it('has a non-empty paths object', () => {
    expect(typeof openApiSpec.paths).toBe('object');
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(10);
  });

  it('has components.schemas with at least 10 shared types', () => {
    expect(typeof openApiSpec.components.schemas).toBe('object');
    expect(Object.keys(openApiSpec.components.schemas).length).toBeGreaterThanOrEqual(10);
  });

  it('has securitySchemes with BearerAuth', () => {
    expect(openApiSpec.components.securitySchemes).toBeDefined();
    const schemes = openApiSpec.components.securitySchemes as Record<string, unknown>;
    expect(schemes).toHaveProperty('BearerAuth');
  });

  it('every path entry has at least one HTTP method with a responses field', () => {
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
      const hasMethod = methods.some((m) => m in pathItem);
      expect(hasMethod, `Path ${path} has no HTTP method`).toBe(true);

      for (const method of methods) {
        if (method in pathItem) {
          const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown>;
          expect(op['responses'], `${method.toUpperCase()} ${path} has no responses`).toBeDefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §2. Coverage — key PRD §8 routes must appear in spec paths
// ---------------------------------------------------------------------------

describe('PRD §8 route coverage', () => {
  /**
   * These are the canonical path prefixes from each PRD §8 section.
   * We check that at least one spec path starts with each prefix.
   *
   * We do NOT check every possible path — that would be fragile.
   * Instead we verify each PRD section has coverage.
   */
  const REQUIRED_PATH_PREFIXES: Array<[string, string]> = [
    // §8.1 Auth
    ['/auth/google/start', 'Auth start (§8.1)'],
    ['/auth/google/callback', 'Auth callback (§8.1)'],
    ['/auth/logout', 'Logout (§8.1)'],
    ['/me', 'Me endpoint (§8.1)'],
    ['/me/tokens', 'Token management (§8.1, §8.12)'],
    // §8.2 Courses
    ['/courses', 'Courses (§8.2)'],
    ['/semesters/{semesterId}', 'Semesters (§8.2)'],
    // §8.3 Members
    ['/semesters/{semesterId}/members', 'Members (§8.3)'],
    // §8.4 Roster
    ['/semesters/{semesterId}/roster', 'Roster (§8.4)'],
    // §8.5 Assignments
    ['/semesters/{semesterId}/assignments', 'Assignments (§8.5)'],
    // §8.6 Ingest
    ['/semesters/{semesterId}/ingest', 'Ingest (§8.6)'],
    // §8.7 Unmatched
    ['/semesters/{semesterId}/unmatched', 'Unmatched (§8.7)'],
    // §8.8 Cohort
    ['/semesters/{semesterId}/submissions', 'Cohort submissions (§8.8)'],
    // §8.9 Per-submission
    ['/submissions/{submissionId}', 'Per-submission (§8.9)'],
    ['/submissions/{submissionId}/events', 'Events (§8.9)'],
    ['/submissions/{submissionId}/bundle', 'Bundle (§8.9)'],
    // §8.10 Cross-flags
    ['/semesters/{semesterId}/cross-flags', 'Cross-flags list (§8.10)'],
    ['/cross-flags/{crossFlagId}', 'Cross-flag detail (§8.10)'],
    // §8.11 Heuristic config
    ['/semesters/{semesterId}/heuristic-config', 'Heuristic config (§8.11)'],
    // §8.13 Audit
    ['/audit', 'Audit (§8.13)'],
    // §8.14 OpenAPI
    ['/openapi.json', 'OpenAPI spec (§8.14)'],
    ['/docs', 'Redoc docs (§8.14)'],
  ];

  const specPaths = Object.keys(openApiSpec.paths);

  for (const [prefix, label] of REQUIRED_PATH_PREFIXES) {
    it(`has coverage for ${label}`, () => {
      const covered = specPaths.some((p) => p === prefix || p.startsWith(prefix));
      expect(covered, `No spec path matches prefix "${prefix}" (${label})`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// §3. GET /api/v1/openapi.json
// ---------------------------------------------------------------------------

describe('GET /api/v1/openapi.json', () => {
  it('returns 200 with valid JSON and correct Content-Type', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['openapi']).toMatch(/^3\.1\./);
    expect(typeof body['paths']).toBe('object');
  });

  it('returns Cache-Control: public, max-age=3600', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('does not require auth (public endpoint)', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));
    // No Authorization header — must still return 200
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §4. GET /api/v1/docs
// ---------------------------------------------------------------------------

describe('GET /api/v1/docs', () => {
  it('returns 200 with HTML content type', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('contains Redoc script tag', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    const html = await res.text();
    expect(html).toContain('redoc.standalone.js');
  });

  it('contains spec-url pointing to openapi.json', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    const html = await res.text();
    expect(html).toContain('/api/v1/openapi.json');
  });

  it('does not require auth (public endpoint)', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));
    expect(res.status).toBe(200);
  });
});
