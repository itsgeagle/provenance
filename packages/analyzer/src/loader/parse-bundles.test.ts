/**
 * Tests for parseBundles (Phase 11 multi-bundle fan-out).
 *
 * parseBundles accepts Blob[] + filenames[] and returns { bundles, errors }.
 * Verified here:
 *   - Two valid ZIPs → two bundles, zero errors.
 *   - Each bundle gets a distinct id (crypto.randomUUID).
 *   - One valid + one invalid → partial result: 1 bundle + 1 error.
 *   - All invalid → 0 bundles + errors for each.
 *   - Error shape includes index + filename.
 */

import { describe, it, expect } from 'vitest';
import { parseBundles } from './parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

const FIXED_NOW = '2026-01-01T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

describe('parseBundles', () => {
  it('returns two bundles + zero errors for two valid ZIPs', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });

    const result = await parseBundles([blob1, blob2], ['a.zip', 'b.zip'], fixedNow);

    expect(result.bundles).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.bundles[0]!.sourceFilename).toBe('a.zip');
    expect(result.bundles[1]!.sourceFilename).toBe('b.zip');
  });

  it('assigns distinct ids to each bundle', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{}] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{}] });

    const result = await parseBundles([blob1, blob2], ['x.zip', 'y.zip'], fixedNow);

    expect(result.bundles).toHaveLength(2);
    const id0 = result.bundles[0]!.id;
    const id1 = result.bundles[1]!.id;
    // IDs must be non-empty strings and distinct from each other.
    expect(typeof id0).toBe('string');
    expect(id0.length).toBeGreaterThan(0);
    expect(id0).not.toBe(id1);
  });

  it('returns one bundle + one error when second file is not a ZIP', async () => {
    const { blob: validBlob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const invalidBlob = new Blob(['not a zip'], { type: 'application/zip' });

    const result = await parseBundles([validBlob, invalidBlob], ['good.zip', 'bad.zip'], fixedNow);

    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]!.sourceFilename).toBe('good.zip');

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.index).toBe(1);
    expect(result.errors[0]!.filename).toBe('bad.zip');
    expect(result.errors[0]!.error.kind).toBe('not_a_zip');
  });

  it('returns zero bundles + two errors when all files are invalid', async () => {
    const bad1 = new Blob(['garbage'], { type: 'application/zip' });
    const bad2 = new Blob(['also garbage'], { type: 'application/zip' });

    const result = await parseBundles([bad1, bad2], ['x.zip', 'y.zip'], fixedNow);

    expect(result.bundles).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.index).toBe(0);
    expect(result.errors[1]!.index).toBe(1);
  });

  it('propagates loadedAt from nowFn to all bundles', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{}] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{}] });

    const result = await parseBundles([blob1, blob2], ['a.zip', 'b.zip'], fixedNow);

    expect(result.bundles).toHaveLength(2);
    expect(result.bundles[0]!.loadedAt).toBe(FIXED_NOW);
    expect(result.bundles[1]!.loadedAt).toBe(FIXED_NOW);
  });

  it('handles an empty blobs array gracefully', async () => {
    const result = await parseBundles([], [], fixedNow);
    expect(result.bundles).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
