/**
 * Unit tests for loadBundle.
 *
 * Builds real in-memory ZIPs via buildTestBundle and verifies the Bundle shape
 * returned by loadBundle. A fixed clock is injected so loadedAt is deterministic.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { loadBundle } from './parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';

// Fixed ISO timestamp injected for all tests — keeps loadedAt assertions stable.
const FIXED_NOW = '2026-01-01T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadBundle', () => {
  it('returns ok with a single-session Bundle for a valid ZIP', async () => {
    const { blob, manifest } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
    });

    const result = await loadBundle(blob, 'hw1-bundle.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.manifest.assignment_id).toBe(manifest.assignment_id);
    expect(bundle.manifest.semester).toBe(manifest.semester);
    expect(bundle.manifest.format_version).toBe('1.0');
    expect(typeof bundle.manifestSigHex).toBe('string');
    expect(bundle.manifestSigHex.length).toBeGreaterThan(0);
  });

  it('sourceFilename is propagated to the Bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'my-hw-bundle.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceFilename).toBe('my-hw-bundle.zip');
  });

  it('loadedAt is the value returned by nowFn', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.loadedAt).toBe(FIXED_NOW);
  });

  it('sessions are sorted oldest → newest by firstEvent.data.wall', async () => {
    // Build two sessions with explicit, reversed wall timestamps.
    // Session 0 wall: newer; Session 1 wall: older.
    // After sort, session 1 should come first.
    const olderWall = '2026-01-01T00:00:00.000Z';
    const newerWall = '2026-01-02T00:00:00.000Z';

    const { blob } = await buildTestBundle({
      sessions: [
        { eventCount: 1, walls: [newerWall, newerWall] },
        { eventCount: 1, walls: [olderWall, olderWall] },
      ],
    });

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessions = result.value.sessions;
    expect(sessions).toHaveLength(2);
    // Oldest first — wall is on the envelope, not on data.
    expect(sessions[0]!.firstEvent.wall).toBe(olderWall);
    expect(sessions[1]!.firstEvent.wall).toBe(newerWall);
  });

  it('each ParsedSession has sessionId, events, meta, and firstEvent populated', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 2 }],
    });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const s = result.value.sessions[0]!;
    expect(typeof s.sessionId).toBe('string');
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.firstEvent.kind).toBe('session.start');
    expect(s.meta.format_version).toBe('1.0');
  });

  it('propagates a parse-session error up from a corrupted slog', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
      tamper: { corruptNdjsonAtLine: { sessionIndex: 0, line: 2 } },
    });

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ndjson_parse_failed');
  });

  it('propagates a LoaderError (not_a_zip) for garbage input', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3]);
    const result = await loadBundle(garbage.buffer as ArrayBuffer, 'bad.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_a_zip');
  });

  it('propagates a LoaderError (missing_manifest) from unzip', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitManifest: true } });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_manifest');
  });

  it('returns not_a_zip with detail for invalid manifest JSON content', async () => {
    // Build a valid ZIP, then manually replace manifest.json with garbage JSON.
    // Use zipBuffer directly — jsdom's Blob may not expose .arrayBuffer().
    const { zipBuffer } = await buildTestBundle({ sessions: [{}] });
    const zip = await JSZip.loadAsync(zipBuffer);
    zip.file('manifest.json', 'NOT JSON AT ALL');
    const newAb = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await loadBundle(newAb, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_a_zip');
    if (result.error.kind !== 'not_a_zip') return;
    expect(result.error.detail).toMatch(/manifest\.json/);
  });
});
