/**
 * API token storage and verification primitives.
 *
 * Tokens have the format: `prov_<prefix>_<random>` where:
 *   - prefix: 8 alphanumeric chars, unique, persisted
 *   - random: ≥32 bytes as base64url (43 chars)
 * Only the prefix and argon2id hash are stored. The full secret is shown once.
 *
 * Token scopes are stored as jsonb and shape-validated at write and query time.
 */

import { hash, verify } from 'argon2';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { DrizzleDb } from '../db/client.js';
import { api_tokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ApiToken } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Token scope schema (PRD §4.5)
// ---------------------------------------------------------------------------

/**
 * Shape of token scopes stored in the database.
 * Enforces the structure defined in PRD §4.5.
 */
export const tokenScopesSchema = z.object({
  read_only: z.boolean().default(false),
  semester_ids: z.union([z.null(), z.array(z.string().uuid())]).default(null),
  include_blobs: z.boolean().default(false),
});

export type TokenScopes = z.infer<typeof tokenScopesSchema>;

// ---------------------------------------------------------------------------
// Token format and generation
// ---------------------------------------------------------------------------

/**
 * Generates a token in the format `prov_<prefix>_<random>`.
 * Returns { prefix, secret } where secret is the full token.
 *
 * Design:
 *   - prefix: 8 alphanumeric chars, generated server-side, unique (enforced by DB unique index)
 *   - random: 32 bytes encoded as base64url (43 chars)
 *   - full secret: prov_<prefix>_<random> (total ~58 chars)
 *
 * Collision: extremely rare due to 8 alphanumeric (52^8 ≈ 53 trillion). Production can
 * retry on UNIQUE constraint failure if needed; tests don't require it.
 */
export interface GeneratedToken {
  prefix: string;
  secret: string;
}

export function generateToken(): GeneratedToken {
  // 8 alphanumeric chars for prefix
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let prefix = '';
  for (let i = 0; i < 8; i++) {
    prefix += chars[Math.floor(Math.random() * chars.length)];
  }

  // 32 bytes encoded as base64url (no padding)
  const random = randomBytes(32).toString('base64url');

  return {
    prefix,
    secret: `prov_${prefix}_${random}`,
  };
}

/**
 * Extracts the prefix from a token string.
 * Returns null if the token is malformed.
 */
export function extractPrefix(token: string): string | null {
  const match = token.match(/^prov_([a-zA-Z0-9]+)_/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Argon2 hashing (PRD §16.3)
// ---------------------------------------------------------------------------

/**
 * Argon2id parameters per PRD §16.3: m=64MB, t=3, p=1.
 * Using the @argon2 package's native bindings on Node 22+.
 */
export async function hashToken(secret: string): Promise<string> {
  return hash(secret, {
    type: 2, // argon2id
    memoryCost: 65536, // 64MB in KB
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyTokenHash(hash: string, secret: string): Promise<boolean> {
  try {
    return await verify(hash, secret, {
      type: 2, // argon2id
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token storage operations
// ---------------------------------------------------------------------------

export interface CreateTokenInput {
  userId: string;
  label: string;
  scopes?: Partial<TokenScopes> | null;
  expiresAt?: Date | null;
}

export interface TokenInfo {
  id: string;
  prefix: string;
  hashedToken: string;
  scopes: TokenScopes;
}

/**
 * Creates a new API token for a user.
 *
 * Returns { prefix, secret, token } where:
 *   - prefix: 8-char unique identifier
 *   - secret: full prov_<prefix>_<random> (shown once)
 *   - token: the database row with hashed_token (not the secret)
 *
 * Scopes are validated and defaults applied (read_only=false, semester_ids=null, include_blobs=false).
 *
 * On prefix collision (extremely rare), retries up to 3 times before failing.
 */
export async function createToken(
  db: DrizzleDb,
  input: CreateTokenInput,
): Promise<{ prefix: string; secret: string; token: ApiToken }> {
  // Validate and apply defaults to scopes
  const scopes = tokenScopesSchema.parse(input.scopes === null ? {} : input.scopes || {});

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { prefix, secret } = generateToken();
    const hashedToken = await hashToken(secret);

    try {
      const rows = await db
        .insert(api_tokens)
        .values({
          user_id: input.userId,
          label: input.label,
          prefix,
          hashed_token: hashedToken,
          scopes: scopes,
          expires_at: input.expiresAt,
        })
        .returning();

      const token = rows[0];
      if (token === undefined) {
        throw new Error('Insert returned no rows');
      }

      return { prefix, secret, token };
    } catch (err) {
      // If it's a unique constraint violation on prefix, retry.
      // Otherwise, propagate.
      // The postgres driver returns error objects with code/constraint properties
      // that aren't well-typed, so we use 'any' to inspect them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = err as any;
      if (error?.code === '23505' && error?.constraint === 'api_tokens_prefix_idx') {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue to next iteration
      } else {
        throw err;
      }
    }
  }

  throw lastError || new Error('Failed to create token after retries');
}

/**
 * Finds a token by its prefix.
 * Returns the token row or null.
 */
export async function findTokenByPrefix(db: DrizzleDb, prefix: string): Promise<ApiToken | null> {
  const rows = await db.select().from(api_tokens).where(eq(api_tokens.prefix, prefix)).limit(1);
  return rows[0] ?? null;
}

/**
 * Verifies a token secret against a stored token row.
 *
 * Checks:
 * 1. Argon2id hash verification
 * 2. revoked_at IS NULL
 * 3. expires_at IS NULL OR expires_at > now()
 *
 * Returns true if all checks pass, false otherwise.
 * Does NOT update last_used_at; that's the caller's responsibility
 * to avoid contention in middleware.
 */
export async function verifyToken(token: ApiToken, secret: string): Promise<boolean> {
  // Check revoked
  if (token.revoked_at !== null && token.revoked_at !== undefined) {
    return false;
  }

  // Check expiry
  if (token.expires_at !== null && token.expires_at !== undefined) {
    if (token.expires_at < new Date()) {
      return false;
    }
  }

  // Verify hash
  return verifyTokenHash(token.hashed_token, secret);
}

/**
 * Marks a token as revoked by setting revoked_at to now().
 * Idempotent: revoking an already-revoked token succeeds.
 */
export async function revokeToken(db: DrizzleDb, tokenId: string): Promise<void> {
  await db.update(api_tokens).set({ revoked_at: new Date() }).where(eq(api_tokens.id, tokenId));
}

/**
 * Updates last_used_at for a token.
 * Called by middleware after successful verification to track usage.
 */
export async function updateTokenLastUsed(db: DrizzleDb, tokenId: string): Promise<void> {
  await db.update(api_tokens).set({ last_used_at: new Date() }).where(eq(api_tokens.id, tokenId));
}
