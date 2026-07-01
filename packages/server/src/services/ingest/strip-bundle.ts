/**
 * stripBundleSourceFiles — produce a provenance-only bundle ZIP.
 *
 * The Gradescope/recorder bundle contains, at the zip root:
 *   - manifest.json, manifest.sig       (the signed manifest + signature)
 *   - session-<uuid>.slog               (NDJSON event logs)
 *   - session-<uuid>.slog.meta          (per-session meta)
 *   - the student's submitted source files
 *
 * After ingest has computed everything from the in-memory full bundle (stats,
 * validation incl. hash-chain + manifest-signature verification and check 8
 * submitted_code_match, and heuristics), the source files are no longer needed
 * server-side: replay/reconstruction and recompute derive file content from the
 * event stream in the `.slog` logs. This strips the source bytes and keeps only
 * the provenance entries.
 *
 * IMPORTANT: the signed `manifest.json` / `manifest.sig` are copied verbatim and
 * never modified — the manifest still lists the (now-absent) submission_files
 * with their hashes, so the bundle remains fully signature- and chain-verifiable
 * (validation checks 1–7). Only check 8 (submitted_code_match) can no longer be
 * re-run against the stored bundle, and it never is (it runs once at ingest).
 *
 * Output is deterministic (stable entry order + fixed timestamps) so the stored
 * blob's sha256 is reproducible.
 */

import JSZip from 'jszip';

/** Fixed timestamp for every emitted entry — keeps output byte-deterministic. */
const FIXED_ENTRY_DATE = new Date(0);

/** True for the entries that make up a provenance-only bundle. */
export function isProvenanceEntry(name: string): boolean {
  return (
    name === 'manifest.json' ||
    name === 'manifest.sig' ||
    name.endsWith('.slog') ||
    name.endsWith('.slog.meta')
  );
}

/**
 * Return a new ZIP containing only the provenance entries of `zipBytes`
 * (manifest.json, manifest.sig, *.slog, *.slog.meta). Source files are dropped.
 */
export async function stripBundleSourceFiles(zipBytes: Uint8Array): Promise<Uint8Array> {
  const input = await JSZip.loadAsync(zipBytes);

  // Stable order for deterministic output.
  const names = Object.keys(input.files).sort();

  const output = new JSZip();
  for (const name of names) {
    const entry = input.files[name];
    if (entry === undefined || entry.dir) continue;
    if (!isProvenanceEntry(name)) continue;
    const bytes = await entry.async('uint8array');
    output.file(name, bytes, { date: FIXED_ENTRY_DATE });
  }

  return output.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
