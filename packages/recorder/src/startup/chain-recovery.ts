/**
 * Startup chain recovery.
 *
 * PRD §4.8: on extension crash → new session, link via prev_session_id.
 * PRD §4.8: on corrupted log → quarantine, new session, emit recovered_from_corruption.
 * PRD §4.6: on startup, validate existing chain.
 *
 * Decision — multiple .slog files / choosing the previous session:
 *   When multiple .slog files exist in provenanceDir we take the one whose
 *   `session.start` carries the latest wall clock — i.e. the genuinely most
 *   recent session.
 *
 *   This used to take the alphabetically last filename, on the reasoning that
 *   "session UUIDs sort in approximate creation order because they embed a
 *   timestamp-influenced prefix in practice." That is not true: these are
 *   UUIDv4 from node:crypto.randomUUID — 122 random bits, no timestamp. Worse,
 *   the filename UUID is a *different* random UUID from the session's own
 *   session_id (see `session-${randomUUID()}.slog` in session-registry.ts), so
 *   filename order carries no information about session order at all.
 *
 *   The observed effect on a real 10-session bundle: six consecutive sessions
 *   all reported the same `prev_session_id`, because one file happened to sort
 *   last and kept winning — including for sessions whose actual predecessor was
 *   a different dangling session. That makes prev_session_id actively
 *   misleading in the analyzer's session graph.
 *
 *   Cost: this reads each .slog once to extract its session.start wall (only
 *   the first line is parsed). provenanceDir holds one file per session for a
 *   single assignment, so the count stays modest. mtime-based ordering would
 *   avoid the reads but needs stat() plumbed through the deps and is falsifiable
 *   by a touch; the recorded wall is the value we actually care about.
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
// Choosing the previous session
// ---------------------------------------------------------------------------

/**
 * Extract the `session.start` wall clock (as ms since epoch) from a .slog's
 * first line. Returns null when the file doesn't start with a parseable
 * `session.start` — such a file is not a usable ordering candidate, and the
 * existing corrupt-handling path deals with it if it ends up being chosen.
 */
function parseSessionStartWall(text: string): number | null {
  const newlineIdx = text.indexOf('\n');
  const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
  if (firstLine.trim().length === 0) return null;

  let entry: { kind?: unknown; wall?: unknown };
  try {
    entry = JSON.parse(firstLine) as { kind?: unknown; wall?: unknown };
  } catch {
    return null;
  }

  if (entry.kind !== 'session.start' || typeof entry.wall !== 'string') return null;

  const wall = Date.parse(entry.wall);
  return Number.isNaN(wall) ? null : wall;
}

/**
 * Pick the .slog whose session.start wall is latest, returning it along with
 * the text already read (so the caller doesn't re-read it).
 *
 * Returns null when no file yields a parseable session.start — the caller then
 * falls back to the alphabetically last file so the corrupt/quarantine path
 * still runs.
 *
 * Reads are sequential, not Promise.all: only one file's text is held at a
 * time besides the current best.
 */
async function chooseMostRecentSlog(
  slogFiles: string[],
  provenanceDir: string,
  readSlogFile: RecoveryDeps['readSlogFile'],
): Promise<{ filename: string; text: string } | null> {
  let best: { filename: string; text: string; wall: number } | null = null;

  for (const filename of slogFiles) {
    const read = await readSlogFile(`${provenanceDir}/${filename}`);
    if (!read.ok) continue;

    const wall = parseSessionStartWall(read.text);
    if (wall === null) continue;

    // Ties (two sessions starting in the same millisecond) fall back to
    // filename order, so the choice stays deterministic.
    if (best === null || wall > best.wall || (wall === best.wall && filename > best.filename)) {
      best = { filename, text: read.text, wall };
    }
  }

  return best === null ? null : { filename: best.filename, text: best.text };
}

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

  // Most recent by session.start wall — see module-level comment for rationale.
  const selected = await chooseMostRecentSlog(slogFiles, provenanceDir, readSlogFile);

  // No file yielded a parseable session.start: fall back to the alphabetically
  // last one so the corrupt/quarantine path below still runs on something.
  const chosen = selected?.filename ?? slogFiles[slogFiles.length - 1];
  if (chosen === undefined) {
    // Should never happen given length > 0, but satisfies noUncheckedIndexedAccess.
    return { kind: 'clean_start' };
  }

  const slogPath = `${provenanceDir}/${chosen}`;
  // Reuse the text from selection when we have it; only re-read on the fallback.
  const readResult: Awaited<ReturnType<RecoveryDeps['readSlogFile']>> =
    selected !== null ? { ok: true, text: selected.text } : await readSlogFile(slogPath);

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
