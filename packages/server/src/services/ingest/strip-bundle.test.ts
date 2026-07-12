import { describe, it, expect } from 'vitest';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { unzipBundle } from '@provenance/analysis-core/loader/unzip.js';
import { stripBundleSourceFiles } from './strip-bundle.js';

/**
 * The critical contract: strip may re-container the bundle (different zip bytes,
 * native-zlib DEFLATE instead of JSZip/pako) but must preserve the DECOMPRESSED
 * provenance content verbatim — especially the signed manifest.json / manifest.sig
 * — so the stored bundle stays signature- and chain-verifiable, while dropping the
 * student source files.
 */
describe('stripBundleSourceFiles', () => {
  it('preserves provenance entries verbatim and drops source files', async () => {
    const built = await buildTestBundle({
      submissionFiles: [
        { path: 'hw.py', status: 'present', content: 'print("secret student source")\n' },
        { path: 'util.py', status: 'present', content: 'def f():\n    return 42\n' },
      ],
    });
    const fullBytes = new Uint8Array(built.zipBuffer);

    // Baseline: parse the full bundle.
    const fullParsed = await unzipBundle(built.zipBuffer);
    expect(fullParsed.ok).toBe(true);
    if (!fullParsed.ok) return;
    // Sanity: source files are present before stripping.
    expect(fullParsed.value.submissionFiles.size).toBeGreaterThan(0);

    // Strip, then re-parse the stored (provenance-only) bundle.
    const stripped = await stripBundleSourceFiles(fullBytes);
    const strippedParsed = await unzipBundle(stripped.buffer as ArrayBuffer);
    expect(strippedParsed.ok).toBe(true);
    if (!strippedParsed.ok) return;

    // Signed manifest + signature byte-identical (guarantees verifiability).
    expect(strippedParsed.value.manifestJson).toBe(fullParsed.value.manifestJson);
    expect(strippedParsed.value.manifestSigHex).toBe(fullParsed.value.manifestSigHex);

    // Every session's .slog / .slog.meta content preserved verbatim.
    expect(strippedParsed.value.sessions.length).toBe(fullParsed.value.sessions.length);
    for (let i = 0; i < fullParsed.value.sessions.length; i++) {
      expect(strippedParsed.value.sessions[i]!.slogText).toBe(
        fullParsed.value.sessions[i]!.slogText,
      );
      expect(strippedParsed.value.sessions[i]!.metaJson).toBe(
        fullParsed.value.sessions[i]!.metaJson,
      );
    }

    // Source files are gone from the stored bundle.
    expect(strippedParsed.value.submissionFiles.size).toBe(0);
    // And the stripped blob is smaller than the original.
    expect(stripped.length).toBeLessThan(fullBytes.length);
  });

  it('is deterministic (same input → identical stored bytes)', async () => {
    const built = await buildTestBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', content: 'x = 1\n' }],
    });
    const bytes = new Uint8Array(built.zipBuffer);
    const a = await stripBundleSourceFiles(bytes);
    const b = await stripBundleSourceFiles(bytes);
    expect(a).toEqual(b);
  });
});
