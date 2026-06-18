/**
 * Parse a Gradescope assignment export ZIP into rosterable submitters and
 * per-submission rebuilt bundle ZIPs.
 *
 * A Gradescope export (downloaded from "Download Submissions") is a single ZIP
 * containing, under one top-level folder:
 *   submission_metadata.yml         — submitter identities per submission
 *   submission_<id>/…               — one folder per submission (unzipped bundle
 *                                     contents + the student's submitted files)
 * plus macOS archive noise (`.DS_Store`, `__MACOSX/`).
 *
 * This is the entry point of the Gradescope ingest path: it locates and parses
 * the metadata, rebuilds a flat bundle ZIP from each submission folder
 * (build-bundle-zip.ts), and returns:
 *   - `rosterSubmitters`: every submitter across the whole export, deduped by
 *     sid (the roster upsert source — analyzer PRD §8.4 / §9.2),
 *   - `bundles`: one entry per submission folder that is a real bundle, carrying
 *     its rebuilt ZIP and submitters (the caller stages one ingest_files row per
 *     submitter, so group co-submitters each get their own submission),
 *   - `skipped`: submission folders that are not bundles (no manifest) — still
 *     rostered, but no bundle to process.
 *
 * Pure with respect to business logic; the only effect is JSZip in/out.
 */

import JSZip from 'jszip';
import { parseSubmissionMetadata, type GradescopeSubmitter } from './parse-metadata.js';
import { buildBundleZipForFolder } from './build-bundle-zip.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const METADATA_FILENAME = 'submission_metadata.yml';

export interface GradescopeBundleEntry {
  /** Submission folder name, e.g. "submission_409194023". */
  folderKey: string;
  /** Submitters of this submission (the caller stages one row per submitter). */
  submitters: GradescopeSubmitter[];
  /** Rebuilt flat bundle ZIP bytes (ready for the existing parse pipeline). */
  bundleZip: ArrayBuffer;
}

export interface GradescopeSkippedEntry {
  folderKey: string;
  submitters: GradescopeSubmitter[];
  reason: 'no_manifest' | 'no_submitters';
}

export interface ParsedGradescopeExport {
  /** All submitters across the export, deduped by sid (roster upsert source). */
  rosterSubmitters: GradescopeSubmitter[];
  /** Submission folders that are real bundles, with their rebuilt ZIPs. */
  bundles: GradescopeBundleEntry[];
  /** Submission folders that could not be processed as bundles. */
  skipped: GradescopeSkippedEntry[];
}

export type ParseExportResult =
  | { ok: true; value: ParsedGradescopeExport }
  | {
      ok: false;
      error: 'not_a_zip' | 'missing_metadata' | 'invalid_metadata';
      detail: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate the `submission_metadata.yml` entry and return its zip object plus the
 * export's folder prefix (everything before the filename). Picks the shallowest
 * match if more than one exists. Returns null if absent.
 */
function locateMetadata(outer: JSZip): { obj: JSZip.JSZipObject; exportPrefix: string } | null {
  let best: { obj: JSZip.JSZipObject; exportPrefix: string } | null = null;
  for (const [name, obj] of Object.entries(outer.files)) {
    if (obj.dir) continue;
    if (name !== METADATA_FILENAME && !name.endsWith(`/${METADATA_FILENAME}`)) continue;
    if (name.includes('__MACOSX/')) continue;
    const exportPrefix = name.slice(0, name.length - METADATA_FILENAME.length);
    if (best === null || exportPrefix.length < best.exportPrefix.length) {
      best = { obj, exportPrefix };
    }
  }
  return best;
}

/** Dedupe submitters by sid, merging in the first non-empty name/email seen. */
function dedupeSubmitters(all: GradescopeSubmitter[]): GradescopeSubmitter[] {
  const bySid = new Map<string, GradescopeSubmitter>();
  for (const s of all) {
    const existing = bySid.get(s.sid);
    if (existing === undefined) {
      bySid.set(s.sid, { ...s });
    } else {
      if (existing.name === undefined && s.name !== undefined) existing.name = s.name;
      if (existing.email === undefined && s.email !== undefined) existing.email = s.email;
    }
  }
  return Array.from(bySid.values());
}

// ---------------------------------------------------------------------------
// parseGradescopeExport
// ---------------------------------------------------------------------------

export async function parseGradescopeExport(
  zipBytes: ArrayBuffer | Uint8Array,
): Promise<ParseExportResult> {
  let outer: JSZip;
  try {
    outer = await JSZip.loadAsync(zipBytes);
  } catch (e) {
    return { ok: false, error: 'not_a_zip', detail: e instanceof Error ? e.message : String(e) };
  }

  const located = locateMetadata(outer);
  if (located === null) {
    return { ok: false, error: 'missing_metadata', detail: `no ${METADATA_FILENAME} in export` };
  }

  const metaText = await located.obj.async('string');
  const parsed = parseSubmissionMetadata(metaText);
  if (!parsed.ok) {
    return { ok: false, error: 'invalid_metadata', detail: `${parsed.error}: ${parsed.detail}` };
  }

  const bundles: GradescopeBundleEntry[] = [];
  const skipped: GradescopeSkippedEntry[] = [];
  const allSubmitters: GradescopeSubmitter[] = [];

  for (const sub of parsed.value.submissions) {
    allSubmitters.push(...sub.submitters);

    if (sub.submitters.length === 0) {
      skipped.push({ folderKey: sub.folderKey, submitters: [], reason: 'no_submitters' });
      continue;
    }

    const folderPrefix = `${located.exportPrefix}${sub.folderKey}/`;
    const built = await buildBundleZipForFolder(outer, folderPrefix);
    if (!built.ok) {
      skipped.push({
        folderKey: sub.folderKey,
        submitters: sub.submitters,
        reason: built.reason,
      });
      continue;
    }

    bundles.push({
      folderKey: sub.folderKey,
      submitters: sub.submitters,
      bundleZip: built.data,
    });
  }

  return {
    ok: true,
    value: {
      rosterSubmitters: dedupeSubmitters(allSubmitters),
      bundles,
      skipped,
    },
  };
}
