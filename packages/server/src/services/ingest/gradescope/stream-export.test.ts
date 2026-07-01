/**
 * Unit tests for openLocalExport — the yauzl-backed streaming reader.
 *
 * Builds a faithful Gradescope export ZIP (submission_metadata.yml + one folder
 * per submission, with macOS noise), writes it to a real temp file on disk
 * (yauzl reads from a path), and asserts the streamed roster + per-submission
 * results. No DB/MinIO — this exercises only the on-disk outer read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { openLocalExport, type StreamedSubmission } from './stream-export.js';

const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  assignmentId: string,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    sessions: [{ eventCount: 3 }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    // Nest provenance files under .provenance/ to exercise prefix stripping.
    const dest = PROVENANCE_FILE.test(name)
      ? `${folderPrefix}.provenance/${name}`
      : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

const METADATA = `submission_solo:
  :submitters:
  - :name: Solo Student
    :sid: '111'
    :email: solo@berkeley.edu
submission_pair:
  :submitters:
  - :name: Pair One
    :sid: '222'
  - :name: Pair Two
    :sid: '333'
submission_nobundle:
  :submitters:
  - :name: No Recorder
    :sid: '444'
submission_empty:
  :submitters: []
`;

describe('openLocalExport (streaming local-path reader)', () => {
  let tmpDir: string;
  let zipPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-stream-export-'));
    zipPath = path.join(tmpDir, 'export.zip');

    const root = 'assignment_8046601_export/';
    const outer = new JSZip();
    outer.file(`${root}submission_metadata.yml`, METADATA);
    outer.file(`${root}.DS_Store`, new Uint8Array([0]));
    outer.file(`__MACOSX/${root}._submission_metadata.yml`, new Uint8Array([0]));
    await layBundleIntoFolder(outer, `${root}submission_solo/`, 'hw10');
    await layBundleIntoFolder(outer, `${root}submission_pair/`, 'proj02');
    // A folder with files but no manifest → skipped no_manifest, submitter still rostered.
    outer.file(`${root}submission_nobundle/answers.txt`, new TextEncoder().encode('no recorder'));

    const buf = await outer.generateAsync({ type: 'nodebuffer' });
    await writeFile(zipPath, buf);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports not_a_zip for a non-zip file', async () => {
    const bad = path.join(tmpDir, 'not.zip');
    await writeFile(bad, 'this is not a zip');
    const res = await openLocalExport(bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_a_zip');
  });

  it('rosters every submitter and streams bundles + skipped folders, bounded', async () => {
    const opened = await openLocalExport(zipPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Roster includes the no-bundle submitter (444); the empty folder adds none.
    expect(new Set(opened.rosterSubmitters.map((s) => s.sid))).toEqual(
      new Set(['111', '222', '333', '444']),
    );

    const seen: StreamedSubmission[] = [];
    for await (const sub of opened.submissions()) {
      seen.push(sub);
    }
    await opened.close();

    const bundles = seen.filter((s) => s.kind === 'bundle');
    const skipped = seen.filter((s) => s.kind === 'skipped');

    // Two real bundles (solo + pair).
    expect(bundles.map((b) => b.folderKey).sort()).toEqual(['submission_pair', 'submission_solo']);

    // The pair carries both co-submitters (caller stages one row each).
    const pair = bundles.find((b) => b.folderKey === 'submission_pair');
    expect(pair?.submitters.map((s) => s.sid).sort()).toEqual(['222', '333']);

    // Each bundle is a valid flat ZIP with a manifest at the root.
    for (const b of bundles) {
      if (b.kind !== 'bundle') continue;
      const inner = await JSZip.loadAsync(b.bundleZip);
      expect(inner.file('manifest.json')).not.toBeNull();
    }

    // Skips: nobundle → no_manifest, empty → no_submitters.
    const skipReasons = Object.fromEntries(
      skipped.map((s) => [s.folderKey, s.kind === 'skipped' ? s.reason : '']),
    );
    expect(skipReasons['submission_nobundle']).toBe('no_manifest');
    expect(skipReasons['submission_empty']).toBe('no_submitters');
  });
});
