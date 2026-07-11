import { describe, it, expect } from 'vitest';
import { parseEnv } from './env.js';

// ---------------------------------------------------------------------------
// Minimal valid env used as a base for all tests.
// All values are controlled here; process.env is never mutated.
// ---------------------------------------------------------------------------

const VALID_BASE: Record<string, string> = {
  NODE_ENV: 'development',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
};

function withOverrides(
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...VALID_BASE, ...overrides };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseEnv — happy path', () => {
  it('parses all required vars from VALID_BASE', () => {
    const cfg = parseEnv(VALID_BASE);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.PUBLIC_BASE_URL).toBe('http://localhost:3000');
    expect(cfg.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/provenance');
    expect(cfg.DATABASE_POOL_MAX).toBe(10);
    expect(cfg.OBJECT_STORAGE_ENDPOINT).toBe('http://localhost:9000');
    expect(cfg.OBJECT_STORAGE_REGION).toBe('auto');
    expect(cfg.OBJECT_STORAGE_BUCKET).toBe('provenance');
    expect(cfg.OBJECT_STORAGE_ACCESS_KEY_ID).toBe('minioadmin');
    expect(cfg.OBJECT_STORAGE_SECRET_ACCESS_KEY).toBe('minioadmin');
    expect(cfg.GOOGLE_OAUTH_CLIENT_ID).toBe('client-id');
    expect(cfg.GOOGLE_OAUTH_CLIENT_SECRET).toBe('client-secret');
    expect(cfg.AUTH_ALLOWED_HOSTED_DOMAINS).toEqual(['berkeley.edu']);
    expect(cfg.AUTH_SUPERADMIN_EMAILS).toEqual(['admin@berkeley.edu']);
    expect(cfg.SESSION_COOKIE_NAME).toBe('__Host-prov_sess');
    expect(cfg.SESSION_TTL_DAYS).toBe(14);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.INGEST_MAX_BUNDLE_BYTES).toBe(52428800);
    expect(cfg.INGEST_MAX_BATCH_BYTES).toBe(5368709120);
    expect(cfg.INGEST_MAX_BATCH_FILES).toBe(10000);
    expect(cfg.RECOMPUTE_MAX_PARALLEL).toBe(4);
    expect(cfg.BLOB_DOWNLOAD_URL_TTL_SECONDS).toBe(300);
  });

  it('accepts explicit PORT override', () => {
    const cfg = parseEnv(withOverrides({ PORT: '8080' }));
    expect(cfg.PORT).toBe(8080);
  });

  it('accepts explicit LOG_LEVEL override', () => {
    const cfg = parseEnv(withOverrides({ LOG_LEVEL: 'debug' }));
    expect(cfg.LOG_LEVEL).toBe('debug');
  });

  it('accepts NODE_ENV=production with correct SESSION_COOKIE_NAME and non-empty superadmins', () => {
    const cfg = parseEnv(
      withOverrides({
        NODE_ENV: 'production',
        SESSION_COOKIE_NAME: '__Host-prov_sess_prod',
        AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
        // Phase 2: AUTH_COOKIE_SIGNING_SECRET required in production.
        AUTH_COOKIE_SIGNING_SECRET: 'a-secure-signing-secret-that-is-long-enough-for-prod',
      }),
    );
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.SESSION_COOKIE_NAME).toBe('__Host-prov_sess_prod');
  });

  it('accepts SMTP_URL when provided', () => {
    const cfg = parseEnv(withOverrides({ SMTP_URL: 'smtp://smtp.example.com:587' }));
    expect(cfg.SMTP_URL).toBe('smtp://smtp.example.com:587');
  });

  it('treats missing SMTP_URL as empty string', () => {
    const cfg = parseEnv(withOverrides({ SMTP_URL: undefined }));
    expect(cfg.SMTP_URL).toBe('');
  });

  it('uses default ["berkeley.edu"] when AUTH_ALLOWED_HOSTED_DOMAINS is absent', () => {
    const cfg = parseEnv(withOverrides({ AUTH_ALLOWED_HOSTED_DOMAINS: undefined }));
    expect(cfg.AUTH_ALLOWED_HOSTED_DOMAINS).toEqual(['berkeley.edu']);
  });

  it('uses default [] when AUTH_SUPERADMIN_EMAILS is absent', () => {
    const cfg = parseEnv(withOverrides({ AUTH_SUPERADMIN_EMAILS: undefined }));
    expect(cfg.AUTH_SUPERADMIN_EMAILS).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Missing required fields — each causes a loud failure
// ---------------------------------------------------------------------------

// AUTH_ALLOWED_HOSTED_DOMAINS and AUTH_SUPERADMIN_EMAILS have schema defaults
// (["berkeley.edu"] and [] respectively), so they do not throw when missing.
// Their "Required: yes" in the PRD means they must be present in a production
// deploy; the cross-field tests below cover the non-empty constraint.
const REQUIRED_KEYS: Array<keyof typeof VALID_BASE> = [
  'PUBLIC_BASE_URL',
  'DATABASE_URL',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
];

describe('parseEnv — missing required vars', () => {
  for (const key of REQUIRED_KEYS) {
    it(`throws when ${key} is missing`, () => {
      expect(() => parseEnv(withOverrides({ [key]: undefined }))).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

describe('parseEnv — cross-field validation', () => {
  it('throws when NODE_ENV=production and SESSION_COOKIE_NAME does not start with __Host-', () => {
    expect(() =>
      parseEnv(
        withOverrides({
          NODE_ENV: 'production',
          SESSION_COOKIE_NAME: 'prov_sess',
          AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
        }),
      ),
    ).toThrow(/SESSION_COOKIE_NAME/);
  });

  it('throws when NODE_ENV=production and AUTH_SUPERADMIN_EMAILS is empty', () => {
    expect(() =>
      parseEnv(
        withOverrides({
          NODE_ENV: 'production',
          AUTH_SUPERADMIN_EMAILS: '[]',
        }),
      ),
    ).toThrow(/AUTH_SUPERADMIN_EMAILS/);
  });

  it('throws when AUTH_ALLOWED_HOSTED_DOMAINS is an empty array', () => {
    expect(() => parseEnv(withOverrides({ AUTH_ALLOWED_HOSTED_DOMAINS: '[]' }))).toThrow(
      /AUTH_ALLOWED_HOSTED_DOMAINS/,
    );
  });

  it('throws when AUTH_ALLOWED_HOSTED_DOMAINS contains an empty string', () => {
    expect(() => parseEnv(withOverrides({ AUTH_ALLOWED_HOSTED_DOMAINS: '[""]' }))).toThrow(
      /AUTH_ALLOWED_HOSTED_DOMAINS/,
    );
  });

  it('throws when AUTH_ALLOWED_HOSTED_DOMAINS is not valid JSON', () => {
    expect(() =>
      parseEnv(withOverrides({ AUTH_ALLOWED_HOSTED_DOMAINS: 'berkeley.edu' })),
    ).toThrow();
  });

  it('throws when AUTH_ALLOWED_HOSTED_DOMAINS is a JSON object (not array)', () => {
    expect(() => parseEnv(withOverrides({ AUTH_ALLOWED_HOSTED_DOMAINS: '{}' }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Type coercions
// ---------------------------------------------------------------------------

describe('parseEnv — type coercions', () => {
  it('throws when PORT is not an integer', () => {
    expect(() => parseEnv(withOverrides({ PORT: 'abc' }))).toThrow();
  });

  it('throws when DATABASE_POOL_MAX is not an integer', () => {
    expect(() => parseEnv(withOverrides({ DATABASE_POOL_MAX: '3.5' }))).toThrow();
  });

  it('throws when NODE_ENV is an unsupported value', () => {
    expect(() => parseEnv(withOverrides({ NODE_ENV: 'staging' }))).toThrow();
  });

  it('throws when LOG_LEVEL is an unsupported value', () => {
    expect(() => parseEnv(withOverrides({ LOG_LEVEL: 'verbose' }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BLOB_STORAGE_BACKEND
// ---------------------------------------------------------------------------

describe('BLOB_STORAGE_BACKEND', () => {
  it('defaults to s3 and requires OBJECT_STORAGE_* (present in base) ', () => {
    const env = parseEnv(VALID_BASE);
    expect(env.BLOB_STORAGE_BACKEND).toBe('s3');
  });

  it('rejects s3 backend missing OBJECT_STORAGE_BUCKET', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { OBJECT_STORAGE_BUCKET: _omit, ...rest } = VALID_BASE;
    expect(() => parseEnv({ ...rest, BLOB_STORAGE_BACKEND: 's3' })).toThrow(/OBJECT_STORAGE/);
  });

  it('accepts fs backend with FS_ROOT + SIGNING_SECRET and no OBJECT_STORAGE_*', () => {
    /* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to omit from ...rest */
    const {
      OBJECT_STORAGE_ENDPOINT,
      OBJECT_STORAGE_BUCKET,
      OBJECT_STORAGE_ACCESS_KEY_ID,
      OBJECT_STORAGE_SECRET_ACCESS_KEY,
      ...rest
    } = VALID_BASE;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const env = parseEnv({
      ...rest,
      BLOB_STORAGE_BACKEND: 'fs',
      BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
      BLOB_URL_SIGNING_SECRET: 'x'.repeat(32),
    });
    expect(env.BLOB_STORAGE_BACKEND).toBe('fs');
    expect(env.BLOB_STORAGE_FS_ROOT).toBe('/srv/provenance/blobs');
  });

  it('rejects fs backend missing BLOB_URL_SIGNING_SECRET', () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        BLOB_STORAGE_BACKEND: 'fs',
        BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
      }),
    ).toThrow(/BLOB_URL_SIGNING_SECRET/);
  });

  it('rejects fs backend with too-short signing secret', () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        BLOB_STORAGE_BACKEND: 'fs',
        BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
        BLOB_URL_SIGNING_SECRET: 'short',
      }),
    ).toThrow();
  });
});

describe('alert config', () => {
  it('applies defaults', () => {
    const env = parseEnv(VALID_BASE);
    expect(env.ALERT_WEBHOOK_MIN_SEVERITY).toBe('warn');
    expect(env.ALERT_WEBHOOK_TIMEOUT_MS).toBe(5000);
    expect(env.ALERT_EMAIL_RECIPIENTS).toEqual([]);
    expect(env.ALERT_SMTP_MIN_SEVERITY).toBe('critical');
    expect(env.ALERT_DEDUPE_WINDOW_SECONDS).toBe(300);
    expect(env.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it('parses a webhook url + recipients array', () => {
    const env = parseEnv({
      ...VALID_BASE,
      ALERT_WEBHOOK_URL: 'https://discord.test/hook',
      ALERT_EMAIL_RECIPIENTS: '["a@berkeley.edu","b@berkeley.edu"]',
    });
    expect(env.ALERT_WEBHOOK_URL).toBe('https://discord.test/hook');
    expect(env.ALERT_EMAIL_RECIPIENTS).toEqual(['a@berkeley.edu', 'b@berkeley.edu']);
  });

  it('rejects a bad severity', () => {
    expect(() => parseEnv({ ...VALID_BASE, ALERT_WEBHOOK_MIN_SEVERITY: 'loud' })).toThrow();
  });
});
