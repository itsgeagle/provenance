/**
 * Bundle signed-URL download route — Phase 18 (PRD §8.9).
 *
 * GET /submissions/:submissionId/bundle
 *
 * Returns a 302 redirect to a short-lived pre-signed S3 GET URL for the
 * submission's raw `.provenance.zip` blob.
 *
 * Auth: read + (for token principals) `scopes.include_blobs === true`.
 * Uses `authorizeBlob()` which extends the standard `authorize()` check with
 * the `include_blobs` scope gate. Inline auth (semesterId derived post-fetch).
 *
 * Rate: blob.download (PRD §8.9 line 1248).
 *
 * Audit: fires `bundle.download` row per PRD §13 (table row 1604).
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import { authorizeBlob } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { insertAuditRow } from '../../middleware/audit.js';
import { submissions } from '../../../db/schema.js';
import { presignGetUrl } from '../../../services/storage/blobs.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getConfig } from '../../../config/index.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createBundleRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/bundle
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/bundle', rateLimit('blob.download'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    // Inline auth + authorizeBlob (adds include_blobs token scope check).
    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorizeBlob(principal, { semesterId }, membership);
    if (!authResult.ok) {
      if (authResult.code === 'TOKEN_BLOB_NOT_PERMITTED') {
        return c.json(Errors.tokenBlobNotPermitted().toBody(), 403);
      }
      if (authResult.code === 'AUTH_REQUIRED') {
        const returnTo = encodeURIComponent(c.req.path);
        return c.json(
          Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
          401,
        );
      }
      // NOT_A_MEMBER / INSUFFICIENT_ROLE → 404 (existence leak prevention, same as other endpoints).
      return c.json(Errors.notFound().toBody(), 404);
    }

    // Fetch blob_object_key from the submission row.
    const submissionRows = await db
      .select({ blob_object_key: submissions.blob_object_key })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);

    if (submissionRows.length === 0) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const blobObjectKey = submissionRows[0]!.blob_object_key;

    // Generate pre-signed URL (TTL from env, default 300s = 5 min).
    const cfg = getConfig();
    const storageClient = createStorageClient(storageConfigFromEnv(cfg));
    const ttl = cfg.BLOB_DOWNLOAD_URL_TTL_SECONDS;
    const signedUrl = await presignGetUrl(storageClient, blobObjectKey, ttl);

    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    // Audit row: bundle.download (fire-and-forget per V19 pattern).
    const actorUserId = principal.user.id;
    const actorTokenId = principal.principal_kind === 'token' ? principal.token.id : null;

    insertAuditRow({
      actorUserId,
      actorTokenId,
      semesterId,
      action: 'bundle.download',
      targetType: 'submission',
      targetId: submissionId,
      detail: { submission_id: submissionId, expires_at: expiresAt },
      ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      at: new Date(),
    }).catch((_err: unknown) => {
      // Fire-and-forget: swallow audit row failures so the redirect is unaffected.
      // Errors are visible in server logs at the insertAuditRow callsite.
    });

    // 302 redirect to the signed URL.
    return c.redirect(signedUrl, 302);
  });

  return router;
}
