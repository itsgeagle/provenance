/**
 * API token CRUD endpoints.
 *
 * GET  /api/v1/me/tokens — list user's tokens
 * POST /api/v1/me/tokens — create a new token
 * DELETE /api/v1/me/tokens/{id} — revoke a token
 *
 * Response shapes:
 *   - TokenSummary: { id, label, prefix, scopes, last_used_at?, expires_at?, revoked_at?, created_at }
 *   - Never includes the secret (only shown once at creation)
 *
 * Auth: session or bearer token (any valid principal).
 * Can only manage own tokens; deleting another user's token returns 404.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { getDb } from '../../../db/client.js';
import { api_tokens } from '../../../db/schema.js';
import { createToken, revokeToken, tokenScopesSchema } from '../../../auth/tokens.js';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Request body for POST /me/tokens — create a new token.
 */
const createTokenRequestSchema = z.object({
  label: z.string().min(1).max(64),
  scopes: tokenScopesSchema.optional(),
  expires_at: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Summary of a token returned to the user.
 * Never includes the hashed_token or secret.
 */
interface TokenSummary {
  id: string;
  label: string;
  prefix: string;
  scopes: any;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function tokenToSummary(token: typeof api_tokens.$inferSelect): TokenSummary {
  const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes;
  return {
    id: token.id,
    label: token.label,
    prefix: token.prefix,
    scopes,
    last_used_at: token.last_used_at ? token.last_used_at.toISOString() : null,
    expires_at: token.expires_at ? token.expires_at.toISOString() : null,
    revoked_at: token.revoked_at ? token.revoked_at.toISOString() : null,
    created_at: token.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createMeTokensRouter(): Hono {
  const router = new Hono();

  // ---------------------------------------------------------------------------
  // GET /me/tokens — list user's tokens
  // ---------------------------------------------------------------------------

  router.get('/', async (c) => {
    const principal = requirePrincipal(c);
    const userId = principal.user.id;
    const db = getDb();

    const tokens = await db
      .select()
      .from(api_tokens)
      .where(eq(api_tokens.user_id, userId as any))
      .orderBy(api_tokens.created_at);

    return c.json({
      tokens: tokens.map(tokenToSummary),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /me/tokens — create a new token
  // ---------------------------------------------------------------------------

  router.post('/', async (c) => {
    const principal = requirePrincipal(c);
    const userId = principal.user.id;

    // Parse and validate request body
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: 'VALIDATION',
            message: 'Invalid JSON body',
          },
        },
        400,
      );
    }

    const parseResult = createTokenRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION',
            message: 'Invalid request body',
            details: { issues: parseResult.error.issues },
          },
        },
        400,
      );
    }

    const { label, scopes, expires_at } = parseResult.data;
    const db = getDb();

    const expiresAtDate = expires_at ? new Date(expires_at) : undefined;

    try {
      const { prefix, secret, token } = await createToken(db, {
        userId,
        label,
        scopes,
        expiresAt: expiresAtDate,
      });

      return c.json(
        {
          token: tokenToSummary(token),
          secret, // Shown once
        },
        201,
      );
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'VALIDATION',
            message: 'Failed to create token',
          },
        },
        400,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /me/tokens/{id} — revoke a token
  // ---------------------------------------------------------------------------

  router.delete('/:id', async (c) => {
    const principal = requirePrincipal(c);
    const userId = principal.user.id;
    const tokenId = c.req.param('id');
    const db = getDb();

    // Check that the token belongs to the user
    const tokens = await db
      .select()
      .from(api_tokens)
      .where(
        and(
          eq(api_tokens.id, tokenId as any),
          eq(api_tokens.user_id, userId as any),
        ),
      )
      .limit(1);

    if (tokens.length === 0) {
      // Don't leak whether the token exists; return 404 either way
      return c.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Token not found',
          },
        },
        404,
      );
    }

    // Revoke the token
    await revokeToken(db, tokenId);

    // Idempotent: return 204 whether newly revoked or already revoked
    return c.body(null, 204);
  });

  return router;
}
