/**
 * Validation orchestrator.
 * PRD §5.4 — runs all 8 checks in spec order and produces a ValidationReport.
 *
 * NOTE: In v1, check 8 (submitted_code_match) is always 'skipped' because the
 * analyzer does not receive course-staff final-file hashes. This means the
 * best overall score a real bundle can achieve in v1 is 'warn', not 'pass'.
 * This is intentional — v1 is an evidence-collection tool, not a verdict
 * system.
 *
 * overall rules:
 *   - Any 'fail' → 'fail'.
 *   - No 'fail' but ≥1 'skipped' → 'warn'.
 *   - All 'pass' → 'pass'.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck, ValidationReport } from './check-types.js';
import { verifyManifestSig } from './verify-manifest-sig.js';
import { verifySessionBinding } from './verify-session-binding.js';
import { verifyChain } from './verify-chain.js';
import { verifySeq } from './verify-seq.js';
import { verifyMonotonicT } from './verify-monotonic-t.js';
import { verifyMonotonicWall } from './verify-monotonic-wall.js';
import { verifyDocSaveHashes } from './verify-doc-save-hashes.js';

// ---------------------------------------------------------------------------
// Check 8 (always skipped in v1)
// ---------------------------------------------------------------------------

const CHECK_8_SKIPPED: ValidationCheck = {
  id: 'submitted_code_match',
  label: 'Submitted code matches final saved hashes',
  status: 'skipped',
  detail:
    'Requires course-staff cross-check input (final file hashes vs submitted code) — not provided in v1.',
};

// ---------------------------------------------------------------------------
// overall computation
// ---------------------------------------------------------------------------

function computeOverall(checks: ValidationCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'skipped')) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runValidation(bundle: Bundle): Promise<ValidationReport> {
  // Checks 1 (async) and 2–7 (sync) run in spec order.
  const check1 = await verifyManifestSig(bundle);
  const check2 = verifySessionBinding(bundle);
  const check3 = verifyChain(bundle);
  const check4 = verifySeq(bundle);
  const check5 = verifyMonotonicT(bundle);
  const check6 = verifyMonotonicWall(bundle);
  const check7 = verifyDocSaveHashes(bundle);
  const check8 = CHECK_8_SKIPPED;

  const checks: ValidationCheck[] = [
    check1,
    check2,
    check3,
    check4,
    check5,
    check6,
    check7,
    check8,
  ];

  return {
    checks,
    overall: computeOverall(checks),
  };
}
