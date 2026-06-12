/**
 * Validation orchestrator.
 * PRD §5.4 — runs all 8 checks in spec order and produces a ValidationReport.
 *
 * NOTE: Check 8 (submitted_code_match) now runs for 1.1 bundles. A clean 1.1
 * bundle (all other checks pass + submitted files match recorded hashes) can
 * reach overall 'pass'. 1.0 bundles still yield overall 'warn' because Check
 * 8 is skipped (empty submissionFiles → skipped).
 *
 * overall rules:
 *   - Any 'fail' → 'fail'.
 *   - No 'fail' but ≥1 'skipped' → 'warn'.
 *   - All 'pass' → 'pass'.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationReport } from './check-types.js';
import { verifyManifestSig } from './verify-manifest-sig.js';
import { verifySessionBinding } from './verify-session-binding.js';
import { verifyChain } from './verify-chain.js';
import { verifySeq } from './verify-seq.js';
import { verifyMonotonicT } from './verify-monotonic-t.js';
import { verifyMonotonicWall } from './verify-monotonic-wall.js';
import { verifyDocSaveHashes } from './verify-doc-save-hashes.js';
import { verifySubmittedCode } from './verify-submitted-code.js';

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
  const check8 = verifySubmittedCode(bundle, { chainIntact: check3.status === 'pass' });

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
