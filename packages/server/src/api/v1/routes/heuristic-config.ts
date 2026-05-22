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
 *
 * ## Audit actions
 *
 *   heuristic_config.read     — GET active config
 *   heuristic_config.history  — GET history
 *   heuristic_config.dry_run  — PUT?dryRun=true
 */

import { Hono } from 'hono';
import { z } from 'zod';
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
// Request schema — PUT body
// ---------------------------------------------------------------------------

const putConfigBodySchema = z.object({}).passthrough(); // accept any object; validateConfig does the real validation

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
  // 13a: only ?dryRun=true is supported.
  // 13b: commit path (dryRun=false) will be added.
  // -------------------------------------------------------------------------

  router.put(
    '/semesters/:semesterId/heuristic-config',
    rateLimit('write.config'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    // Audit is wired here; the handler sets c.var.auditDetail with candidateVersion.
    audit('heuristic_config.dry_run', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const dryRunStr = c.req.query('dryRun');
      const isDryRun = dryRunStr === 'true';

      // -----------------------------------------------------------------------
      // 501 stub: commit path not available in Phase 13a.
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

      const parseResult = putConfigBodySchema.safeParse(rawBody);
      if (!parseResult.success) {
        throw Errors.validation(parseResult.error.issues);
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
