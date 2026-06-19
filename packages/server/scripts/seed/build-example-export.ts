/**
 * Builds the example Gradescope export ZIP used to seed a dev database.
 *
 * The output is byte-for-byte the same shape Gradescope produces from
 * "Download Submissions": a single archive containing
 *   submission_metadata.yml          — submitter identities per submission
 *   submission_<key>/.provenance/…    — one folder per submission, holding the
 *                                       (unzipped) recorder bundle files
 * plus a non-bundle folder to exercise the "skipped" path.
 *
 * The recorder bundles are produced by the analyzer's `buildTestBundle` helper
 * (the same helper the server's e2e ingest tests use). Event timelines, walls,
 * and UUIDs are deterministic; only the per-build ed25519 signing key is random,
 * so re-running the generator yields a logically-identical export with a fresh
 * signature. The seed script commits one generated ZIP and reuses it by default
 * so repeated `npm run seed` runs dedupe cleanly.
 *
 * This is dev tooling, not shipped server code — hence it lives under
 * `scripts/` and is free to import the analyzer test helper (the server package
 * already depends on `@provenance/analyzer`).
 */

import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analyzer/test/helpers/build-test-bundle.js';

/** Recorder bundle files belong under `<folder>/.provenance/`; everything else stays flat. */
const PROVENANCE_FILE = /^(manifest\.(json|sig)|session-[0-9a-fA-F-]+\.slog(\.meta)?)$/;

// ---------------------------------------------------------------------------
// The example cohort. One assignment (hw10), five rostered students:
//   - two solo submitters with bundles of differing length,
//   - one pair (group submission — two co-submitters share one bundle),
//   - one student who submitted without the recorder (no bundle → skipped, but
//     still rostered from the metadata).
// ---------------------------------------------------------------------------

export interface SeedSubmitter {
  name: string;
  sid: string;
  email: string;
}

export interface SeedSubmission {
  /** Submission folder key; also the metadata top-level key. */
  folder: string;
  /** Assignment id baked into the bundle manifest, or null for the no-bundle case. */
  assignmentId: string | null;
  /** doc.change events in the single session (drives timeline length). */
  eventCount: number;
  submitters: SeedSubmitter[];
}

// A dedicated, clearly-labelled namespace so the seed NEVER collides with or
// mutates a real semester someone is working in. `ensureSemester` keys on this
// slug, so re-running only ever touches the seed's own semester.
export const SEED_SEMESTER = {
  courseName: 'CS 61A (seed)',
  courseSlug: 'seed-cs61a',
  term: 'fa' as const,
  year: 2026,
  slug: 'seed-demo',
  displayName: 'Seed Demo — CS 61A',
  // Gradescope ingest matches by metadata sid, not filename, but the column is
  // required and used by the non-Gradescope upload path.
  filenameConvention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
};

export const SEED_ASSIGNMENT_ID = 'hw10';
export const SEED_BUNDLE_SEMESTER = 'fa2026';

export const SEED_SUBMISSIONS: SeedSubmission[] = [
  {
    folder: 'submission_alice',
    assignmentId: SEED_ASSIGNMENT_ID,
    eventCount: 6,
    submitters: [{ name: 'Alice Nguyen', sid: '100001', email: 'alice@berkeley.edu' }],
  },
  {
    folder: 'submission_bob',
    assignmentId: SEED_ASSIGNMENT_ID,
    eventCount: 14,
    submitters: [{ name: 'Bob Lee', sid: '100002', email: 'bob@berkeley.edu' }],
  },
  {
    folder: 'submission_pair',
    assignmentId: SEED_ASSIGNMENT_ID,
    eventCount: 9,
    submitters: [
      { name: 'Carol Diaz', sid: '100003', email: 'carol@berkeley.edu' },
      { name: 'Dan Park', sid: '100004', email: 'dan@berkeley.edu' },
    ],
  },
  {
    folder: 'submission_norecorder',
    assignmentId: null,
    eventCount: 0,
    submitters: [{ name: 'Erin Smith', sid: '100005', email: 'erin@berkeley.edu' }],
  },
];

/** Every distinct submitter across the export (the roster the ingest will upsert). */
export const SEED_ROSTER: SeedSubmitter[] = SEED_SUBMISSIONS.flatMap((s) => s.submitters);

const EXPORT_ROOT = 'assignment_hw10_export/';

/** Render the Ruby-symbol `submission_metadata.yml` Gradescope emits. */
function renderMetadata(): string {
  let out = '';
  for (const sub of SEED_SUBMISSIONS) {
    out += `${sub.folder}:\n  :submitters:\n`;
    for (const s of sub.submitters) {
      out += `  - :name: ${s.name}\n    :sid: '${s.sid}'\n    :email: ${s.email}\n`;
    }
  }
  return out;
}

/** Lay one recorder bundle into `<folderPrefix>.provenance/…` inside the export. */
async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  assignmentId: string,
  eventCount: number,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: SEED_BUNDLE_SEMESTER,
    sessions: [{ eventCount }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const dest = PROVENANCE_FILE.test(name)
      ? `${folderPrefix}.provenance/${name}`
      : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

/** Build the full Gradescope export ZIP for the seed cohort. */
export async function buildExampleExportZip(): Promise<Uint8Array> {
  const outer = new JSZip();
  outer.file(`${EXPORT_ROOT}submission_metadata.yml`, renderMetadata());
  // A stray macOS file, to prove the loader ignores archive noise.
  outer.file(`${EXPORT_ROOT}.DS_Store`, new Uint8Array([0]));

  for (const sub of SEED_SUBMISSIONS) {
    const prefix = `${EXPORT_ROOT}${sub.folder}/`;
    if (sub.assignmentId === null) {
      // No recorder bundle — just a plain submitted file. Folder is rostered but
      // skipped (no_manifest).
      outer.file(`${prefix}answers.txt`, new TextEncoder().encode('submitted without recorder\n'));
    } else {
      await layBundleIntoFolder(outer, prefix, sub.assignmentId, sub.eventCount);
    }
  }

  const buf = await outer.generateAsync({ type: 'arraybuffer' });
  return new Uint8Array(buf);
}
