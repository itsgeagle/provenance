/**
 * unzipBundle — reads a Blob/ArrayBuffer ZIP and returns typed BundleFiles.
 *
 * PRD §5.3: a sealed bundle ZIP contains (flat, no subdirectories):
 *   manifest.json        — BundleManifest (JCS canonical JSON)
 *   manifest.sig         — hex ed25519 signature
 *   session-<uuid>.slog  — NDJSON event log per session
 *   session-<uuid>.slog.meta — JSON meta per session
 *
 * For 1.1 bundles, submission files listed in `manifest.submission_files[].path`
 * are also present at the zip root. These are whitelisted on a two-pass read.
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
  // 2. First pass: read manifest + sig + known provenance files; defer the rest.
  //
  // We must read manifest.json before we can whitelist submission files, so
  // unrecognized entries are deferred until after the manifest is parsed.
  // ---------------------------------------------------------------------------

  let manifestJson: string | null = null;
  let manifestSigHex: string | null = null;
  const slogIds = new Set<string>();
  const metaIds = new Set<string>();
  const slogContents = new Map<string, string>();
  const metaContents = new Map<string, string>();
  // Deferred: entries that are neither manifest/sig nor slog/meta — may be
  // submission files (whitelisted below) or genuinely unexpected files.
  type ZipFileObject = Awaited<ReturnType<typeof JSZip.loadAsync>>['files'][string];
  const deferred: Array<[string, ZipFileObject]> = [];

  for (const [filename, zipObject] of Object.entries(zip.files)) {
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

    // Unknown — defer until we know the submission file whitelist.
    deferred.push([filename, zipObject]);
  }

  if (manifestJson === null) {
    return err({ kind: 'missing_manifest' });
  }

  if (manifestSigHex === null) {
    return err({ kind: 'missing_signature' });
  }

  // ---------------------------------------------------------------------------
  // 3. Build the submission-file whitelist from the manifest (best-effort parse).
  //
  // Full shape validation happens later in parse-bundle. Here we only need the
  // `submission_files[].path` strings to decide which deferred entries are OK.
  // A malformed manifest (bad JSON / missing key) → empty whitelist, so every
  // deferred entry will trigger unexpected_file (parse-bundle will then surface
  // the manifest error independently).
  // ---------------------------------------------------------------------------
  const submissionPaths = new Set<string>();
  try {
    const parsed = JSON.parse(manifestJson) as { submission_files?: Array<{ path?: unknown }> };
    for (const f of parsed.submission_files ?? []) {
      if (typeof f?.path === 'string') {
        submissionPaths.add(f.path);
      }
    }
  } catch {
    // Malformed manifest JSON — parse-bundle will surface invalid_manifest.
    // Leave submissionPaths empty → all deferred entries become unexpected_file.
  }

  // ---------------------------------------------------------------------------
  // 4. Process deferred entries: whitelist submission files; reject everything else.
  // ---------------------------------------------------------------------------
  const submissionFiles = new Map<string, Uint8Array>();
  for (const [filename, zipObject] of deferred) {
    if (submissionPaths.has(filename)) {
      submissionFiles.set(filename, await zipObject.async('uint8array'));
    } else {
      return err({ kind: 'unexpected_file', filename, detail: 'not a recognized bundle file' });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Structural checks.
  // ---------------------------------------------------------------------------

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
  // 6. Build the result.
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
    submissionFiles,
  });
}
