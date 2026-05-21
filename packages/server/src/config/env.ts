import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const intStr = (defaultVal?: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const raw = v ?? (defaultVal !== undefined ? String(defaultVal) : undefined);
      if (raw === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || isNaN(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected integer, got "${raw}"` });
        return z.NEVER;
      }
      return n;
    });

const optionalUrlStr = z
  .string()
  .optional()
  .transform((v) => v ?? '')
  .pipe(z.union([z.string().url(), z.literal('')]));

const jsonStringArray = z.string().transform((v, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected JSON array, got "${v}"` });
    return z.NEVER;
  }
  if (!Array.isArray(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected JSON array, got non-array` });
    return z.NEVER;
  }
  if (!parsed.every((item): item is string => typeof item === 'string')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected JSON array of strings' });
    return z.NEVER;
  }
  return parsed as string[];
});

// ---------------------------------------------------------------------------
// Raw schema (all strings, as they arrive from process.env)
// ---------------------------------------------------------------------------

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: intStr(3000),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: intStr(10),
  OBJECT_STORAGE_ENDPOINT: z.string().url(),
  OBJECT_STORAGE_REGION: z.string().min(1).default('auto'),
  OBJECT_STORAGE_BUCKET: z.string().min(1),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  AUTH_ALLOWED_HOSTED_DOMAINS: jsonStringArray.default('["berkeley.edu"]'),
  AUTH_SUPERADMIN_EMAILS: jsonStringArray.default('[]'),
  // Phase 2 addition: signing secret for the __Host-prov_oauth cookie.
  // Required in production (enforced in cross-field validation below).
  // Defaults to a fixed dev-only value when NODE_ENV !== 'production'.
  // See .notes/v3-progress.md §V14 for design decision.
  AUTH_COOKIE_SIGNING_SECRET: z
    .string()
    .optional()
    .transform((v) => v ?? 'dev-only-insecure-signing-secret-change-in-prod'),
  SESSION_COOKIE_NAME: z.string().min(1).default('__Host-prov_sess'),
  SESSION_TTL_DAYS: intStr(14),
  SMTP_URL: optionalUrlStr,
  SMTP_FROM: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  RATE_LIMIT_REDIS_URL: optionalUrlStr,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  INGEST_MAX_BUNDLE_BYTES: intStr(52428800),
  INGEST_MAX_BATCH_BYTES: intStr(5368709120),
  INGEST_MAX_BATCH_FILES: intStr(10000),
  RECOMPUTE_MAX_PARALLEL: intStr(4),
  BLOB_DOWNLOAD_URL_TTL_SECONDS: intStr(300),
});

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

export const envSchema = rawEnvSchema.superRefine((data, ctx) => {
  // AUTH_ALLOWED_HOSTED_DOMAINS must be non-empty
  if (data.AUTH_ALLOWED_HOSTED_DOMAINS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_ALLOWED_HOSTED_DOMAINS'],
      message: 'AUTH_ALLOWED_HOSTED_DOMAINS must be a non-empty array',
    });
  }

  // AUTH_ALLOWED_HOSTED_DOMAINS entries must be non-empty strings
  if (data.AUTH_ALLOWED_HOSTED_DOMAINS.some((d) => d.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_ALLOWED_HOSTED_DOMAINS'],
      message: 'AUTH_ALLOWED_HOSTED_DOMAINS entries must be non-empty strings',
    });
  }

  if (data.NODE_ENV === 'production') {
    // SESSION_COOKIE_NAME must start with __Host- in production
    if (!data.SESSION_COOKIE_NAME.startsWith('__Host-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_COOKIE_NAME'],
        message: 'SESSION_COOKIE_NAME must start with "__Host-" in production',
      });
    }

    // AUTH_SUPERADMIN_EMAILS must be non-empty in production
    if (data.AUTH_SUPERADMIN_EMAILS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SUPERADMIN_EMAILS'],
        message: 'AUTH_SUPERADMIN_EMAILS must be non-empty in production',
      });
    }

    // AUTH_COOKIE_SIGNING_SECRET must be explicitly set in production
    // (the transform default is the dev-only sentinel; check for it)
    if (data.AUTH_COOKIE_SIGNING_SECRET === 'dev-only-insecure-signing-secret-change-in-prod') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_COOKIE_SIGNING_SECRET'],
        message: 'AUTH_COOKIE_SIGNING_SECRET must be set explicitly in production',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 *
 * Takes a `Record<string, string | undefined>` so tests can pass a controlled
 * stub without mutating `process.env` globally.
 *
 * Throws a descriptive `Error` on invalid input (fails loud, per PRD §3.1).
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return result.data;
}
