/**
 * unzipBundle — reads a Blob/ArrayBuffer ZIP and returns typed BundleFiles.
 *
 * PRD §5.3: a sealed bundle ZIP contains (flat, no subdirectories):
 *   manifest.json        — BundleManifest (JCS canonical JSON)
 *   manifest.sig         — hex ed25519 signature
 *   session-<uuid>.slog  — NDJSON event log per session
 *   session-<uuid>.slog.meta — JSON meta per session
 *
 * Any other file produces `unexpected_file`. Orphaned .slog (no .meta) or
 * orphaned .meta (no .slog) produce typed errors. Zero .slog files → no_sessions.
 *
 * Design: pure except for the JSZip async read. No Node APIs; browser-safe.
 */

import JSZip from 'jszip';
import { ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';
import type { BundleFiles, LoaderError } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_JSON = 'manifest.json';
const MANIFEST_SIG = 'manifest.sig';

/**
 * Matches `session-<uuid>.slog` — captures the UUID.
 * Does NOT match `session-<uuid>.slog.meta` (the `$` anchors at .slog end).
 */
const SLOG_RE = /^session-([0-9a-f-]+)\.slog$/;

/**
 * Matches `session-<uuid>.slog.meta` — captures the UUID.
 */
const SLOG_META_RE = /^session-([0-9a-f-]+)\.slog\.meta$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Unzip a bundle and return its raw constituent files.
 *
 * @param input  A `Blob` or `ArrayBuffer` containing the ZIP bytes.
 *               JSZip's `loadAsync` accepts both; passing an ArrayBuffer is
 *               safe in jsdom (Vitest) environments where Blob may behave
 *               differently. Callers may pass either.
 */
export async function unzipBundle(
  input: Blob | ArrayBuffer,
): Promise<Result<BundleFiles, LoaderError>> {
  // ---------------------------------------------------------------------------
  // 1. Parse the ZIP.
  // ---------------------------------------------------------------------------
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch (e) {
    return err({
      kind: 'not_a_zip',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Categorize every file in the ZIP.
  // ---------------------------------------------------------------------------

  let manifestJson: string | null = null;
  let manifestSigHex: string | null = null;
  const slogIds = new Set<string>();
  const metaIds = new Set<string>();
  const slogContents = new Map<string, string>();
  const metaContents = new Map<string, string>();

  // Collect all filenames first so we can check for unexpected files.
  const fileEntries = Object.entries(zip.files);

  for (const [filename, zipObject] of fileEntries) {
    // Skip directories (JSZip may include them).
    if (zipObject.dir) {
      continue;
    }

    if (filename === MANIFEST_JSON) {
      manifestJson = await zipObject.async('string');
      continue;
    }

    if (filename === MANIFEST_SIG) {
      manifestSigHex = (await zipObject.async('string')).trim();
      continue;
    }

    const slogMatch = SLOG_RE.exec(filename);
    if (slogMatch !== null) {
      const sessionId = slogMatch[1]!;
      slogIds.add(sessionId);
      slogContents.set(sessionId, await zipObject.async('string'));
      continue;
    }

    const metaMatch = SLOG_META_RE.exec(filename);
    if (metaMatch !== null) {
      const sessionId = metaMatch[1]!;
      metaIds.add(sessionId);
      metaContents.set(sessionId, await zipObject.async('string'));
      continue;
    }

    // Unrecognized file — reject with `unexpected_file`.
    return err({ kind: 'unexpected_file', filename, detail: 'not a recognized bundle file' });
  }

  // ---------------------------------------------------------------------------
  // 3. Structural checks.
  // ---------------------------------------------------------------------------

  if (manifestJson === null) {
    return err({ kind: 'missing_manifest' });
  }

  if (manifestSigHex === null) {
    return err({ kind: 'missing_signature' });
  }

  if (slogIds.size === 0) {
    return err({ kind: 'no_sessions' });
  }

  // Check for orphaned .slog.meta (meta without matching slog).
  for (const metaId of metaIds) {
    if (!slogIds.has(metaId)) {
      return err({ kind: 'orphaned_meta', sessionId: metaId });
    }
  }

  // Check for orphaned .slog (slog without matching meta).
  for (const slogId of slogIds) {
    if (!metaIds.has(slogId)) {
      return err({ kind: 'orphaned_slog', sessionId: slogId });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Build the result.
  // ---------------------------------------------------------------------------

  const sessions = Array.from(slogIds).map((sessionId) => ({
    sessionId,
    slogText: slogContents.get(sessionId)!,
    metaJson: metaContents.get(sessionId)!,
  }));

  return ok({
    manifestJson,
    manifestSigHex,
    sessions,
  });
}
