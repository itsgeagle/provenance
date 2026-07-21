/**
 * Check 8 — submitted_code_match (PRD §5.4 step 8).
 *
 * For each reviewed file, compare the submitted file's hash (from the bundle's
 * signed manifest, re-verified against the zip bytes during loadBundle) to the
 * recorder's LAST recorded on-disk hash for that file — the sha256 of the most
 * recent doc.save / fs.external_change(new_hash) / doc.open across the bundle.
 *
 *   match               → pass
 *   mismatch, chain ok  → fail  (file edited outside the recording)
 *   chain broken        → skip  (Check 3 already fails this)
 *   no usable events    → skip
 *   status 'missing'    → skip  (nothing submitted to compare)
 *   bytes present but
 *     hashOk === false  → fail  (bundle bytes don't match their own manifest hash)
 *
 * No reconstruction: we compare recorded hashes only, so reconstruction taint
 * is irrelevant here.
 *
 * RE-RUNNABLE against a stored, source-stripped bundle. The tamper sub-check is
 * gated on bytes actually being present; the match comparison needs only the
 * signed manifest's sha256 and the recorded event hashes, both of which survive
 * source stripping. (Before 2026-07 absent bytes were indistinguishable from
 * wrong bytes, so any re-run reported every stored bundle as tampered — hence
 * the old "never re-run check 8" rule.)
 *
 * NOTE: 1.0 bundles (no submission_files) → check is skipped entirely.
 * 1.1 bundles with at least one matching file can reach overall 'pass'.
 */
import type { HashedEnvelope } from '@provenance/log-core';
import { resolveAliasesForBundle } from '../index/build-index.js';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export type SubmittedFileVerdict = {
  path: string;
  status: 'present' | 'missing';
  /** 'match' | 'mismatch' | 'unknown' (skip) */
  verdict: 'match' | 'mismatch' | 'unknown';
  submittedSha: string | null;
  recordedSha: string | null;
  detail: string;
  supportingSeqs: Array<{ sessionId: string; seq: number }>;
};

/**
 * Last recorded on-disk hash per file, scanning all sessions in order.
 *
 * Paths are canonicalized through the workspace-root alias map (D3) first. A
 * student who worked on one file from two different workspace roots records it
 * under two relative paths; without this, check 8 looks up only the manifest's
 * spelling and finds a STALE save from whichever sessions used that root —
 * then reports "File was changed outside the recording" against a submission
 * that matches the log exactly. See `.notes/reconstruction-triage.md` (D3).
 */
function lastRecordedHashes(
  bundle: Bundle,
): Map<string, { sha: string; sessionId: string; seq: number }> {
  const out = new Map<string, { sha: string; sessionId: string; seq: number }>();
  const aliases = resolveAliasesForBundle(bundle);
  for (const session of bundle.sessions) {
    for (const event of session.events as readonly HashedEnvelope[]) {
      let path: string | undefined;
      let sha: string | undefined;
      if (event.kind === 'doc.save' || event.kind === 'doc.open') {
        const d = event.data as { path: string; sha256: string };
        path = d.path;
        sha = d.sha256;
      } else if (event.kind === 'fs.external_change') {
        const d = event.data as { path: string; new_hash: string };
        path = d.path;
        sha = d.new_hash;
      }
      if (path !== undefined && sha !== undefined) {
        out.set(aliases.get(path) ?? path, { sha, sessionId: session.sessionId, seq: event.seq });
      }
    }
  }
  return out;
}

/** Per-file verdicts; shared by Check 8 and the Source view. */
export function submittedFileVerdicts(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): SubmittedFileVerdict[] {
  const recorded = lastRecordedHashes(bundle);
  const verdicts: SubmittedFileVerdict[] = [];

  for (const [path, f] of bundle.submissionFiles) {
    if (f.status === 'missing') {
      verdicts.push({
        path,
        status: 'missing',
        verdict: 'unknown',
        submittedSha: null,
        recordedSha: null,
        detail: 'File listed in files_under_review but absent on disk at seal time.',
        supportingSeqs: [],
      });
      continue;
    }
    // Tamper sub-check. Only assert tampering when we actually HAVE bytes that
    // disagree with the manifest. A stored bundle is provenance-only — student
    // source is stripped after ingest — so `bytes` is absent and `hashOk` is
    // trivially false there (parse-bundle.ts:157 folds "absent" and "wrong"
    // into one flag). Treating that as tampering reported every stored bundle
    // as tampered on any re-run, which is why check 8 was previously
    // un-re-runnable.
    //
    // With bytes absent we fall through to the hash comparison below, which
    // needs only `f.sha256` (from the signed manifest — check 1 verifies that
    // signature) and the recorded event hashes. Both survive stripping, so the
    // match verdict is fully computable against a stored bundle.
    if (f.bytes !== undefined && !f.hashOk) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
        supportingSeqs: [],
      });
      continue;
    }
    if (!opts.chainIntact) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Hash chain is broken; cannot trust recorded hashes.',
        supportingSeqs: [],
      });
      continue;
    }
    const rec = recorded.get(path);
    if (rec === undefined) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'No doc.open/doc.save/fs.external_change recorded for this file.',
        supportingSeqs: [],
      });
      continue;
    }
    if (rec.sha === f.sha256) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'match',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: 'Submitted file matches the last recorded on-disk state.',
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    } else {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: `Submitted sha256 ${f.sha256} != last recorded on-disk sha256 ${rec.sha}. File was changed outside the recording.`,
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    }
  }
  return verdicts;
}

export function verifySubmittedCode(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): ValidationCheck {
  // 1.0 bundles / no submission files → nothing to check.
  if (bundle.submissionFiles.size === 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail: 'Bundle has no submission files (format 1.0).',
    };
  }

  const verdicts = submittedFileVerdicts(bundle, opts);
  const mismatches = verdicts.filter((v) => v.verdict === 'mismatch');
  const matches = verdicts.filter((v) => v.verdict === 'match');

  if (mismatches.length > 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'fail',
      detail: `${mismatches.length} submitted file(s) do not match the recording: ${mismatches.map((m) => `${m.path} (${m.detail})`).join(' | ')}`,
      supportingSeqs: mismatches.flatMap((m) => m.supportingSeqs),
    };
  }
  if (matches.length === 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail: 'No submitted file could be checked (chain broken, missing, or no recorded state).',
    };
  }
  return {
    id: 'submitted_code_match',
    label: 'Submitted code matches recorded final state',
    status: 'pass',
    detail: `${matches.length} submitted file(s) match the recorded final state.`,
  };
}
