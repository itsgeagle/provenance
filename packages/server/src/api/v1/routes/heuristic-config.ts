/**
 * Heuristic config routes — Phase 13a (PRD §8.11).
 *
 * GET    /semesters/:semesterId/heuristic-config    — get active config (semester member)
 * GET    /semesters/:semesterId/heuristic-configs   — list history (semester member)
 * PUT    /semesters/:semesterId/heuristic-config    — dry-run only (semester admin)
 *
 * ## PUT ?dryRun=true
 *
 * - Validates the candidate config (422 on invalid).
 * - Requires `If-Match: <currentVersion>` header:
 *     - Missing → 428 PRECONDITION_REQUIRED
 *     - Mismatch → 409 CONFIG_VERSION_CONFLICT
 * - Returns DryRunDiff per PRD §8.11.
 *
 * ## PUT ?dryRun=false (or omitted)
 *
 * Returns 501 NOT_IMPLEMENTED — the commit path ships in Phase 13b.
 * No audit action is emitted for the 501 stub (no operation occurred).
 *
 * ## Audit actions
 *
 *   heuristic_config.read     — GET active config
 *   heuristic_config.history  — GET history
 *   heuristic_config.dry_run  — PUT?dryRun=true
 *   heuristic_config.commit   — PUT?dryRun=false (Phase 13b, not yet implemented)
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  getActiveConfig,
  listConfigHistory,
  validateConfig,
  DEFAULT_SERVER_CONFIG,
} from '../../../services/heuristics/config.js';
import { computeDryRunDiff } from '../../../services/scoring/dry-run.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createHeuristicConfigRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/heuristic-config — active config
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/heuristic-config',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('heuristic_config.read', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const active = await getActiveConfig(db, semesterId);
      if (!active) {
        // No config yet (semester has no admin, backfill was skipped).
        // Return the default config as a virtual v0 response.
        return c.json({
          id: null,
          version: 0,
          config: DEFAULT_SERVER_CONFIG,
          set_at: null,
          note: 'default (no config committed yet)',
          is_active: true,
        });
      }

      return c.json({
        id: active.id,
        version: active.version,
        config: active.config,
        set_at: active.set_at.toISOString(),
        note: active.note,
        is_active: true,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/heuristic-configs — version history
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/heuristic-configs',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('heuristic_config.history', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const history = await listConfigHistory(db, semesterId);

      return c.json({
        configs: history.map((row) => ({
          id: row.id,
          version: row.version,
          set_at: row.set_at.toISOString(),
          set_by: row.set_by,
          note: row.note,
          is_active: row.is_active,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PUT /semesters/:semesterId/heuristic-config — dry-run or commit
  //
  // 13a: only ?dryRun=true is implemented.
  // 13b: commit path (dryRun=false) replaces the 501 stub.
  //
  // Audit action: heuristic_config.dry_run, emitted only when dryRun=true
  // succeeds (2xx). The audit middleware skips on non-2xx responses, so the
  // 501 stub path (dryRun=false) produces no audit entry — correct because no
  // operation occurred. Phase 13b's commit handler will wire its own
  // audit('heuristic_config.commit', ...) in the same 3-line composition.
  // -------------------------------------------------------------------------

  router.put(
    '/semesters/:semesterId/heuristic-config',
    rateLimit('write.config'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    // audit placed before the final handler (V19 3-line composition pattern).
    // Only fires on 2xx; the 501 stub path returns 501, so no audit row is
    // written for the commit-not-implemented case.
    audit('heuristic_config.dry_run', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const isDryRun = c.req.query('dryRun') === 'true';

      // -----------------------------------------------------------------------
      // 501 stub: commit path not available in Phase 13a.
      // Returns 501 (non-2xx) → audit middleware does NOT insert a row.
      // Phase 13b replaces this entire block with a real commit handler wired
      // with audit('heuristic_config.commit', ...).
      // -----------------------------------------------------------------------
      if (!isDryRun) {
        return c.json(
          {
            error: {
              code: 'NOT_IMPLEMENTED',
              message:
                'commit path lands in Phase 13b; use ?dryRun=true to preview the diff without writing',
            },
          },
          501,
        );
      }

      // -----------------------------------------------------------------------
      // If-Match header validation (required even in dry-run to prevent
      // diffing against a stale version).
      // -----------------------------------------------------------------------
      const ifMatch = c.req.header('If-Match');
      if (!ifMatch) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message:
                'If-Match header is required; set it to the current active config version (or "0" if none)',
            },
          },
          428,
        );
      }

      const ifMatchVersion = parseInt(ifMatch, 10);
      if (isNaN(ifMatchVersion)) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message: 'If-Match header must be a numeric version string',
            },
          },
          428,
        );
      }

      // -----------------------------------------------------------------------
      // Check current active config version against If-Match.
      // -----------------------------------------------------------------------
      const db = getDb();
      const active = await getActiveConfig(db, semesterId);
      const currentVersion = active?.version ?? 0;

      if (ifMatchVersion !== currentVersion) {
        throw Errors.configVersionConflict(currentVersion);
      }

      // -----------------------------------------------------------------------
      // Parse + validate the request body.
      // -----------------------------------------------------------------------
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        throw Errors.validation([{ message: 'Request body must be valid JSON' }]);
      }

      const validationResult = validateConfig(rawBody);
      if (!validationResult.ok) {
        throw Errors.heuristicConfigInvalid(validationResult.errors.join('; '));
      }

      // -----------------------------------------------------------------------
      // Compute the candidate version (current + 1).
      // -----------------------------------------------------------------------
      const candidateVersion = currentVersion + 1;

      // Set auditDetail so the audit middleware (wired above) includes it.
      // The audit middleware reads c.var.auditDetail after the handler returns.
      c.set('auditDetail', { semesterId, candidate_version: candidateVersion });

      // -----------------------------------------------------------------------
      // Run the dry-run diff.
      // -----------------------------------------------------------------------
      const diff = await computeDryRunDiff(
        db,
        semesterId,
        validationResult.config,
        candidateVersion,
      );

      return c.json(diff);
    },
  );

  return router;
}
