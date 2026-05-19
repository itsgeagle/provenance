/**
 * Startup chain recovery.
 *
 * PRD §4.8: on extension crash → new session, link via prev_session_id.
 * PRD §4.8: on corrupted log → quarantine, new session, emit recovered_from_corruption.
 * PRD §4.6: on startup, validate existing chain.
 *
 * Decision — multiple .slog files / tie-breaking:
 *   When multiple .slog files exist in provenanceDir, we take the alphabetically last
 *   one. Session UUIDs (via node:crypto.randomUUID) sort in approximate creation order
 *   because they embed a timestamp-influenced prefix in practice, but more importantly,
 *   any consistent tie-breaking rule is sufficient: we just need to pick one. Alphabetical
 *   last is simple, deterministic, and easy to test. (mtime-based ordering would require
 *   stat() calls and introduces TOCTOU risk; we prefer the simpler path for Phase 9.)
 *
 * Decision — prev_session_id linkage:
 *   We only set prev_session_id on the dangling case (crash, no session.end).
 *   For a completed session (last entry is session.end) the prior session ended cleanly;
 *   linking to it adds no information and clutters the analyzer's session graph.
 *   This matches PRD §4.8: "On reload, we open a new session, link it to the previous
 *   via the prev_session_id field" — "reload" implies a crash, not a clean close.
 *
 * Decision — corruption surfacing:
 *   When the prior chain fails to validate, we DO NOT emit a `chain.broken` event into
 *   the new session. We quarantine the corrupt file (renamed to `<slog>.corrupt-<ISO>`)
 *   and emit `recorder.recovered_from_corruption` with the quarantined path; the analyzer
 *   inspects the quarantined file directly. PRD §4.6 documents this as the canonical
 *   behavior. `chain.broken` remains in the event type system but is reserved for any
 *   future case where the live session detects its own chain breaking mid-stream.
 */

import { parseEntries, validateChain } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryDecision =
  | { kind: 'clean_start' }
  | { kind: 'previous_session_complete'; prevSessionId: string }
  | { kind: 'previous_session_dangling'; prevSessionId: string; danglingPath: string }
  | { kind: 'previous_session_corrupt'; quarantinedPath: string };

export type RecoveryDeps = {
  provenanceDir: string;
  /** Read a .slog file; returns its text or an error indication. */
  readSlogFile: (
    path: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: 'not_found' | 'read_error' }>;
  /** Rename a file (used for quarantine). */
  rename: (from: string, to: string) => Promise<void>;
  /** List all .slog files in the directory (filenames only, not full paths). */
  listSlogFiles: (dir: string) => Promise<string[]>;
  /** Returns current Date (for quarantine timestamp). */
  now: () => Date;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Inspect the provenanceDir for a previous session and return a recovery decision.
 *
 * Side effects:
 *   - If the chain is invalid: renames the slog to <slog>.corrupt-<ISO> (quarantine).
 *
 * Returns RecoveryDecision — callers decide what to do (e.g. set prev_session_id).
 */
export async function recoverPreviousSession(deps: RecoveryDeps): Promise<RecoveryDecision> {
  const { provenanceDir, readSlogFile, rename, listSlogFiles, now } = deps;

  // List all .slog files.
  const filenames = await listSlogFiles(provenanceDir);
  const slogFiles = filenames.filter((f) => f.endsWith('.slog')).sort();

  if (slogFiles.length === 0) {
    return { kind: 'clean_start' };
  }

  // Alphabetically last — see module-level comment for rationale.
  const chosen = slogFiles[slogFiles.length - 1];
  if (chosen === undefined) {
    // Should never happen given length > 0, but satisfies noUncheckedIndexedAccess.
    return { kind: 'clean_start' };
  }

  const slogPath = `${provenanceDir}/${chosen}`;
  const readResult = await readSlogFile(slogPath);

  if (!readResult.ok) {
    // Can't read the file at all — treat as corrupt.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  // Parse the entries.
  const parseResult = parseEntries(readResult.text);
  if (!parseResult.ok) {
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  const entries = parseResult.value;

  // Validate the chain.
  const chainResult = validateChain(entries);
  if (!chainResult.ok) {
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  // Chain is valid — extract session_id from the first entry (session.start, seq 0).
  const firstEntry = entries[0];
  if (firstEntry === undefined || firstEntry.kind !== 'session.start') {
    // No session.start — malformed; quarantine.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  const data = firstEntry.data as Record<string, unknown>;
  const prevSessionId = typeof data['session_id'] === 'string' ? data['session_id'] : null;

  if (prevSessionId === null) {
    // session.start data doesn't have a session_id — malformed; quarantine.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  // Determine if the session ended cleanly.
  const lastEntry = entries[entries.length - 1];
  const isComplete = lastEntry !== undefined && lastEntry.kind === 'session.end';

  if (isComplete) {
    return { kind: 'previous_session_complete', prevSessionId };
  } else {
    // Dangling — extension crashed without emitting session.end.
    return { kind: 'previous_session_dangling', prevSessionId, danglingPath: slogPath };
  }
}
