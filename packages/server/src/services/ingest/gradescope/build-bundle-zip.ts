/**
 * Rebuild a sealed-bundle ZIP from an unzipped Gradescope submission folder.
 *
 * Gradescope unzips each student's submitted bundle on upload, so in the export
 * a submission appears as a *folder* (e.g. `submission_409194023/`) rather than
 * a `.zip`. The recorder's seal (recorder PRD §5.3, seal.ts) produces a FLAT
 * bundle ZIP — `manifest.json`, `manifest.sig`, `session-*.slog`,
 * `session-*.slog.meta`, and any submission files all at the ZIP root — and the
 * analyzer loader (`loader/unzip.ts`) requires exactly that flat shape, rejecting
 * any unrecognized file.
 *
 * This module reconstructs that flat ZIP from a folder so the existing parse →
 * validation → heuristics pipeline can consume it unchanged. It is robust to
 * both observed folder layouts:
 *   - provenance files nested under `<folder>/.provenance/…` (we strip the prefix), and
 *   - provenance files flat at `<folder>/…`.
 * Only recognized provenance files plus the manifest-whitelisted submission
 * files are included; macOS junk (`.DS_Store`, `__MACOSX/`, AppleDouble `._*`)
 * and any other stray files are dropped so the loader never sees an unexpected
 * entry.
 *
 * Pure with respect to business logic; the only effect is JSZip in/out.
 */

import JSZip from 'jszip';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_PREFIX = '.provenance/';
const MANIFEST_JSON = 'manifest.json';
const MANIFEST_SIG = 'manifest.sig';
const SLOG_RE = /^session-[0-9a-fA-F-]+\.slog$/;
const SLOG_META_RE = /^session-[0-9a-fA-F-]+\.slog\.meta$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuildBundleZipResult =
  | { ok: true; data: ArrayBuffer }
  /** The folder has no manifest.json — it is not a provenance bundle. */
  | { ok: false; reason: 'no_manifest' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** macOS archive noise that must never reach the bundle loader. */
function isJunkPath(relPath: string): boolean {
  if (relPath.includes('__MACOSX/')) return true;
  return relPath.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
}

/** Normalize a folder-relative path to its bundle-root equivalent. */
function toBundlePath(relPath: string): string {
  return relPath.startsWith(PROVENANCE_PREFIX) ? relPath.slice(PROVENANCE_PREFIX.length) : relPath;
}

function isProvenanceFile(bundlePath: string): boolean {
  return (
    bundlePath === MANIFEST_JSON ||
    bundlePath === MANIFEST_SIG ||
    SLOG_RE.test(bundlePath) ||
    SLOG_META_RE.test(bundlePath)
  );
}

/** Best-effort read of submission_files[].path from raw manifest JSON. */
function submissionPathsFromManifest(manifestJson: string): Set<string> {
  const paths = new Set<string>();
  try {
    const parsed = JSON.parse(manifestJson) as { submission_files?: Array<{ path?: unknown }> };
    for (const f of parsed.submission_files ?? []) {
      if (typeof f?.path === 'string') paths.add(f.path);
    }
  } catch {
    // Malformed manifest — the parse phase will surface invalid_manifest later.
  }
  return paths;
}

// ---------------------------------------------------------------------------
// buildBundleZipFromFiles (core)
// ---------------------------------------------------------------------------

/**
 * Rebuild a flat bundle ZIP from one submission folder's already-materialized
 * files, keyed by folder-relative path (e.g. `manifest.json`,
 * `.provenance/manifest.json`, `hw10.py`).
 *
 * This is the storage-agnostic core: it takes raw bytes per path rather than a
 * JSZip handle, so both the in-memory JSZip path (`buildBundleZipForFolder`)
 * and the streaming local-path reader (`stream-export.ts`, which extracts one
 * folder at a time from disk) share identical selection/whitelist logic.
 *
 * @param files Map of folder-relative path → file bytes for ONE submission
 *              folder. Directory entries must already be excluded.
 * @returns `{ ok: true, data }` with the rebuilt ZIP bytes, or
 *          `{ ok: false, reason: 'no_manifest' }` when the folder is not a bundle.
 */
export async function buildBundleZipFromFiles(
  files: Map<string, Uint8Array>,
): Promise<BuildBundleZipResult> {
  // Collect candidate entries: bundle-root path → bytes, dropping macOS junk.
  // `.provenance/` prefixes are stripped so the resulting paths are
  // bundle-root-relative.
  const candidates = new Map<string, Uint8Array>();
  let manifestJsonBytes: Uint8Array | null = null;

  for (const [rel, bytes] of files) {
    if (rel.length === 0 || isJunkPath(rel)) continue;

    const bundlePath = toBundlePath(rel);
    // Prefer a `.provenance/`-nested entry over a flat one on collision: a
    // stripped path wins because it is the canonical bundle location.
    const isStripped = rel.startsWith(PROVENANCE_PREFIX);
    if (!candidates.has(bundlePath) || isStripped) {
      candidates.set(bundlePath, bytes);
    }

    if (bundlePath === MANIFEST_JSON && (isStripped || manifestJsonBytes === null)) {
      manifestJsonBytes = bytes;
    }
  }

  if (manifestJsonBytes === null) {
    return { ok: false, reason: 'no_manifest' };
  }

  const submissionPaths = submissionPathsFromManifest(new TextDecoder().decode(manifestJsonBytes));

  const out = new JSZip();
  for (const [bundlePath, bytes] of candidates) {
    if (!isProvenanceFile(bundlePath) && !submissionPaths.has(bundlePath)) {
      continue; // not a recognized bundle file — drop it
    }
    out.file(bundlePath, bytes);
  }

  const data = await out.generateAsync({ type: 'arraybuffer' });
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// buildBundleZipForFolder (JSZip adapter)
// ---------------------------------------------------------------------------

/**
 * Rebuild a flat bundle ZIP from the entries of one submission folder of a
 * loaded export ZIP. Thin adapter over `buildBundleZipFromFiles`.
 *
 * @param outer        The loaded export ZIP.
 * @param folderPrefix The folder's prefix within `outer`, INCLUDING the trailing
 *                     slash (e.g. `assignment_8046601_export/submission_409194023/`).
 * @returns `{ ok: true, data }` with the rebuilt ZIP bytes, or
 *          `{ ok: false, reason: 'no_manifest' }` when the folder is not a bundle.
 */
export async function buildBundleZipForFolder(
  outer: JSZip,
  folderPrefix: string,
): Promise<BuildBundleZipResult> {
  const files = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(outer.files)) {
    if (obj.dir) continue;
    if (!name.startsWith(folderPrefix)) continue;
    const rel = name.slice(folderPrefix.length);
    if (rel.length === 0) continue;
    files.set(rel, await obj.async('uint8array'));
  }
  return buildBundleZipFromFiles(files);
}
