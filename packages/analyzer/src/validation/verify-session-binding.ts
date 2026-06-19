/**
 * Check 2 — Session binding.
 * PRD §5.4 step 2.
 *
 * Each session's session.start.data.manifest_sig is the signature copied from
 * the .provenance-manifest assignment manifest the session was started against. All sessions
 * in a bundle should have been started against the same assignment, meaning
 * their manifest_sig values should all be identical.
 *
 * If they differ the bundle mixes sessions from different assignments — broken
 * trust chain.
 *
 * The BundleManifest type (log-core bundle.ts) does not carry a manifest_sig
 * field, so we can only check session-to-session equality here.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifySessionBinding(bundle: Bundle): ValidationCheck {
  if (bundle.sessions.length === 0) {
    // The loader already rejects empty session arrays, but guard defensively.
    return {
      id: 'session_binding',
      label: 'Session binding to assignment manifest',
      status: 'fail',
      detail: 'Bundle contains no sessions.',
    };
  }

  const firstSig = bundle.sessions[0]!.firstEvent.data.manifest_sig;

  for (let i = 1; i < bundle.sessions.length; i++) {
    const session = bundle.sessions[i]!;
    const sig = session.firstEvent.data.manifest_sig;
    if (sig !== firstSig) {
      return {
        id: 'session_binding',
        label: 'Session binding to assignment manifest',
        status: 'fail',
        detail:
          `Session ${session.sessionId} was started against a different assignment manifest ` +
          `(manifest_sig mismatch vs session ${bundle.sessions[0]!.sessionId}). ` +
          `This bundle mixes sessions from different assignments.`,
        supportingSeqs: [{ sessionId: session.sessionId, seq: 0 }],
      };
    }
  }

  return {
    id: 'session_binding',
    label: 'Session binding to assignment manifest',
    status: 'pass',
    detail:
      bundle.sessions.length === 1
        ? 'Single session; binding trivially consistent.'
        : `All ${bundle.sessions.length} sessions share the same manifest_sig.`,
  };
}
