/**
 * Tests for parseBundlePhase (PRD §9.3 phase 3).
 *
 * Uses withTestMinio for real blob I/O and buildTestBundle from the analyzer
 * test helpers for in-memory bundle construction.
 *
 * NOTE: No committed fixture ZIP exists yet — the analyzer test helpers
 * (`buildTestBundle`) are used to generate deterministic in-memory ZIPs for
 * each test case. This is the same pattern used in the analyzer's own loader
 * tests, ensuring behavioral consistency without a committed binary fixture.
 */

import { vi, describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { parseBundlePhase } from './parse-bundle-phase.js';
import { putBlob } from '../storage/blobs.js';
import { ingestStagingKey } from '../storage/keys.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stageBundle(
  client: import('../../../test/helpers/minio.js').TestMinioContext['client'],
  jobId: string,
  fileId: string,
  bundleBuffer: ArrayBuffer,
): Promise<string> {
  const key = ingestStagingKey(jobId, fileId);
  await putBlob(client, key, bundleBuffer);
  return key;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseBundlePhase', () => {
  it('returns ok:true with a parsed Bundle for a valid bundle ZIP', async () => {
    await withTestMinio(async ({ client }) => {
      const { zipBuffer, manifest } = await buildTestBundle({
        sessions: [{ eventCount: 3 }],
      });

      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const key = await stageBundle(client, jobId, fileId, zipBuffer);

      const result = await parseBundlePhase(client, key, 'hw01-123456.zip');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.manifest.assignment_id).toBe(manifest.assignment_id);
      expect(result.bundle.sessions).toHaveLength(1);
      expect(result.bundle.sourceFilename).toBe('hw01-123456.zip');
    });
  });

  it('returns ok:false with cause=not_a_zip for garbage bytes', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const key = ingestStagingKey(jobId, fileId);
      await putBlob(client, key, garbage);

      const result = await parseBundlePhase(client, key, 'bad.zip');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.phase).toBe('parse_bundle');
      expect(result.cause).toBe('not_a_zip');
    });
  });

  it('returns ok:false with cause=missing_manifest for a ZIP without manifest.json', async () => {
    await withTestMinio(async ({ client }) => {
      const { zipBuffer } = await buildTestBundle({ tamper: { omitManifest: true } });

      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const key = await stageBundle(client, jobId, fileId, zipBuffer);

      const result = await parseBundlePhase(client, key, 'no-manifest.zip');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.phase).toBe('parse_bundle');
      expect(result.cause).toBe('missing_manifest');
    });
  });

  it('returns ok:false with cause=invalid_manifest for a ZIP with bad manifest JSON', async () => {
    await withTestMinio(async ({ client }) => {
      const { zipBuffer } = await buildTestBundle({ sessions: [{}] });
      // Replace manifest.json with invalid JSON.
      const zip = await JSZip.loadAsync(zipBuffer);
      zip.file('manifest.json', 'NOT JSON AT ALL');
      const badBuffer = await zip.generateAsync({ type: 'arraybuffer' });

      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const key = await stageBundle(client, jobId, fileId, badBuffer);

      const result = await parseBundlePhase(client, key, 'bad-manifest.zip');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.phase).toBe('parse_bundle');
      expect(result.cause).toBe('invalid_manifest');
    });
  });

  it('returns ok:false with cause=blob_read_failed for a missing staging key', async () => {
    await withTestMinio(async ({ client }) => {
      const missingKey = `ingest-staging/${crypto.randomUUID()}/${crypto.randomUUID()}`;

      const result = await parseBundlePhase(client, missingKey, 'missing.zip');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.phase).toBe('parse_bundle');
      expect(result.cause).toBe('blob_read_failed');
    });
  });

  it('parses a multi-session bundle correctly', async () => {
    await withTestMinio(async ({ client }) => {
      const { zipBuffer } = await buildTestBundle({
        sessions: [{ eventCount: 2 }, { eventCount: 3 }],
      });

      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const key = await stageBundle(client, jobId, fileId, zipBuffer);

      const result = await parseBundlePhase(client, key, 'multi-session.zip');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.sessions).toHaveLength(2);
    });
  });
});
