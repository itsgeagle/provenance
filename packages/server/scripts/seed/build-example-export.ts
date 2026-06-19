/**
 * Builds the example Gradescope export ZIP used to seed a dev database.
 *
 * The output is the shape Gradescope produces from "Download Submissions": a
 * single archive containing
 *   submission_metadata.yml          — submitter identities per submission
 *   submission_<key>/.provenance/…    — one folder per submission, holding the
 *                                       (unzipped) recorder bundle files
 * plus a non-bundle folder to exercise the "skipped" path.
 *
 * The recorder bundles are produced by the analyzer's `buildTestBundle` helper
 * (the same helper the server's e2e ingest tests use). Everything except the
 * per-build ed25519 signing key is deterministic — the roster, assignments,
 * event timelines and paste contents are all derived from the student index, so
 * the cohort, flags, and cross-flags are stable across regenerations.
 *
 * The cohort is sized for a realistic browse (~700 students across three
 * assignments) and seeds a spread of heuristic findings:
 *   - most students type normally (no flags),
 *   - some paste a large unique blob       → `large_paste` (per submission),
 *   - clusters of students paste IDENTICAL blobs on the same assignment
 *                                          → `large_paste` + `paste_shared_across_students`
 *                                            (cross-submission),
 *   - a few group submissions (co-submitters share a bundle) and a few
 *     no-recorder folders (rostered but skipped).
 *
 * This is dev tooling, not shipped server code — hence it lives under
 * `scripts/` and is free to import the analyzer test helper (the server package
 * already depends on `@provenance/analyzer`).
 */

import JSZip from 'jszip';
import { sha256Hex } from '@provenance/log-core';
import {
  buildTestBundle,
  type EventSpec,
} from '@provenance/analyzer/test/helpers/build-test-bundle.js';

/** Recorder bundle files belong under `<folder>/.provenance/`; everything else stays flat. */
const PROVENANCE_FILE = /^(manifest\.(json|sig)|session-[0-9a-fA-F-]+\.slog(\.meta)?)$/;

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

/** Semester string baked into each bundle manifest (cosmetic; ingest uses the DB semester). */
export const SEED_BUNDLE_SEMESTER = 'fa2026';

/** Assignments the cohort is spread across (drives the analyzer's assignment switcher). */
export const SEED_ASSIGNMENTS = ['hw10', 'hw11', 'proj02'] as const;

/** Default cohort size. */
export const SEED_STUDENT_COUNT = 700;

// ---------------------------------------------------------------------------
// Deterministic roster generation
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Alice',
  'Bob',
  'Carol',
  'Dan',
  'Erin',
  'Frank',
  'Grace',
  'Hassan',
  'Iris',
  'Jian',
  'Kavya',
  'Leo',
  'Mira',
  'Noah',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Umar',
  'Vera',
  'Wes',
  'Xinyi',
  'Yara',
  'Zach',
  'Ana',
  'Bao',
  'Chloe',
  'Diego',
];
const LAST_NAMES = [
  'Adams',
  'Bauer',
  'Chen',
  'Diaz',
  'Evans',
  'Foster',
  'Gupta',
  'Huang',
  'Ito',
  'Jain',
  'Kim',
  'Lopez',
  'Mehta',
  'Nguyen',
  'Okoro',
  'Park',
  'Qureshi',
  'Rao',
  'Silva',
  'Tanaka',
  'Ueda',
  'Vargas',
  'Wong',
  'Xu',
  'Yadav',
  'Zhang',
  'Ali',
  'Brooks',
  'Cruz',
  'Dubois',
];

export interface SeedSubmitter {
  name: string;
  sid: string;
  email: string;
}

/** Deterministic student for index i (0-based). sids start at 200001. */
function makeStudent(i: number): SeedSubmitter {
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const sid = String(200001 + i);
  return {
    name: `${first} ${last}`,
    sid,
    email: `${first}.${last}${i}@berkeley.edu`.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Paste-content plans
// ---------------------------------------------------------------------------

/**
 * Shared paste snippets. Students assigned the same snippet paste byte-identical
 * content, so the cross heuristic groups them (sha256-exact) into one
 * `paste_shared_across_students` flag. Two snippets per assignment; one of each
 * pair is long enough (≥500 chars) to be high-severity `large_paste` too.
 */
const SHARED_SNIPPETS: Array<{ assignment: string; text: string }> = SEED_ASSIGNMENTS.flatMap(
  (assignment, ai) => [
    {
      assignment,
      text:
        `# ${assignment} — shared solution A\n` +
        Array.from(
          { length: 14 },
          (_, j) => `    acc = acc + step(${(ai + 1) * (j + 1)})  # line ${j}`,
        ).join('\n') +
        '\n    return acc\n',
    },
    {
      assignment,
      text:
        `# ${assignment} — shared solution B\n` +
        Array.from(
          { length: 34 },
          (_, j) => `    total = total + helper(${(ai + 2) * (j + 3)}, ${j})  # row ${j}`,
        ).join('\n') +
        '\n    return total\n',
    },
  ],
);

/** A unique (per-student) large paste — distinct lines so solos never group together. */
function soloPasteText(student: SeedSubmitter): string {
  const lines = Array.from(
    { length: 12 },
    (_, j) =>
      `result_${student.sid}_${j} = compute(${(Number(student.sid) * (j + 1)) % 97}, "${student.name}")`,
  );
  return `# personal work — ${student.name} (${student.sid})\n${lines.join('\n')}\n`;
}

type PastePlan = { kind: 'clean' } | { kind: 'solo' } | { kind: 'shared'; snippetIndex: number };

/** Deterministic per-bundle paste plan. Keyed off the bundle's first submitter index. */
function pastePlanFor(studentIndex: number, assignment: string): PastePlan {
  if (studentIndex % 7 === 0) {
    const pool = SHARED_SNIPPETS.map((s, idx) => ({ s, idx })).filter(
      (e) => e.s.assignment === assignment,
    );
    const pick = pool[Math.floor(studentIndex / 7) % pool.length]!;
    return { kind: 'shared', snippetIndex: pick.idx };
  }
  if (studentIndex % 5 === 0) return { kind: 'solo' };
  return { kind: 'clean' };
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

const POINT_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
const EDIT_PATH = '/hw/solution.py';
const SHA_EMPTY = sha256Hex('');

/** Deterministic PRNG (mulberry32) so each student's timeline is varied but reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Safe "filler" event kinds with trivially-valid payloads. The cross
 * `editing_pattern_clone` heuristic compares the SET of event-KIND 3-grams
 * between bundles, so a varied per-student mix keeps most students from looking
 * like editing-pattern clones of each other (a uniform `doc.change` stream
 * makes every pair score 1.0). None of these trigger a per-submission flag with
 * the payloads used here. Weighted toward `doc.change` for realism.
 */
const FILLER_KINDS: Array<{ kind: string; weight: number; data: () => Record<string, unknown> }> = [
  {
    kind: 'doc.change',
    weight: 3,
    data: () => ({ path: EDIT_PATH, deltas: [{ range: POINT_RANGE, text: 'x' }], source: 'typed' }),
  },
  {
    kind: 'selection.change',
    weight: 2,
    data: () => ({ path: EDIT_PATH, range: POINT_RANGE, was_selection: false }),
  },
  { kind: 'focus.change', weight: 2, data: () => ({ gained: true }) },
  {
    kind: 'session.heartbeat',
    weight: 2,
    data: () => ({ focused: true, active_file: EDIT_PATH, idle_since_ms: 0 }),
  },
  {
    kind: 'doc.open',
    weight: 1,
    data: () => ({ path: EDIT_PATH, sha256: SHA_EMPTY, line_count: 0 }),
  },
  { kind: 'git.event', weight: 1, data: () => ({ operation: 'status' }) },
  {
    kind: 'terminal.open',
    weight: 1,
    data: () => ({ terminal_id: 't1', shell: 'bash', shell_integration: true }),
  },
];
const FILLER_TOTAL_WEIGHT = FILLER_KINDS.reduce((n, k) => n + k.weight, 0);

function pickFiller(rand: number): EventSpec {
  let r = rand * FILLER_TOTAL_WEIGHT;
  for (const f of FILLER_KINDS) {
    if (r < f.weight) return { kind: f.kind, data: f.data() };
    r -= f.weight;
  }
  const last = FILLER_KINDS[FILLER_KINDS.length - 1]!;
  return { kind: last.kind, data: last.data() };
}

/**
 * Build one bundle's event stream: a varied, per-student-deterministic sequence
 * of safe filler events, with the paste (if any) inserted partway through. The
 * variety is what keeps `editing_pattern_clone` from flagging nearly every pair.
 */
function buildEvents(plan: PastePlan, firstStudent: SeedSubmitter): EventSpec[] {
  const rng = mulberry32(Number(firstStudent.sid));
  const length = 12 + Math.floor(rng() * 14); // 12–25 events
  const events: EventSpec[] = [];
  for (let i = 0; i < length; i++) events.push(pickFiller(rng()));

  let pasteText: string | null = null;
  if (plan.kind === 'solo') pasteText = soloPasteText(firstStudent);
  else if (plan.kind === 'shared') pasteText = SHARED_SNIPPETS[plan.snippetIndex]!.text;

  if (pasteText !== null) {
    const at = Math.floor(rng() * (events.length + 1));
    events.splice(at, 0, {
      kind: 'paste',
      data: {
        path: EDIT_PATH,
        range: POINT_RANGE,
        length: pasteText.length,
        sha256: sha256Hex(pasteText),
        content: pasteText,
      },
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Submission plan
// ---------------------------------------------------------------------------

interface SeedSubmission {
  folder: string;
  /** Assignment baked into the bundle manifest, or null for the no-recorder case. */
  assignmentId: string | null;
  submitters: SeedSubmitter[];
  events: EventSpec[];
}

export interface SeedStats {
  roster: number;
  bundles: number;
  submissionsQueued: number;
  skipped: number;
  assignments: readonly string[];
  pasteBundles: number;
  sharedClusters: number;
}

const N_GROUPS = 6; // group submissions (two co-submitters share one bundle)
const N_SKIPS = 6; // no-recorder folders (rostered, skipped)

export function planSubmissions(studentCount: number): {
  subs: SeedSubmission[];
  stats: SeedStats;
} {
  const subs: SeedSubmission[] = [];
  let si = 0;
  const next = (): SeedSubmitter => makeStudent(si++);
  let pasteBundles = 0;

  // Group submissions — two co-submitters, normal typed work.
  for (let g = 0; g < N_GROUPS && si + 2 <= studentCount; g++) {
    const assignment = SEED_ASSIGNMENTS[g % SEED_ASSIGNMENTS.length]!;
    const submitters = [next(), next()];
    subs.push({
      folder: `submission_group_${g}`,
      assignmentId: assignment,
      submitters,
      events: buildEvents({ kind: 'clean' }, submitters[0]!),
    });
  }

  // No-recorder folders — rostered but skipped.
  for (let k = 0; k < N_SKIPS && si < studentCount; k++) {
    subs.push({
      folder: `submission_skip_${k}`,
      assignmentId: null,
      submitters: [next()],
      events: [],
    });
  }

  // Solo submissions for the remaining students.
  while (si < studentCount) {
    const idx = si;
    const student = next();
    const assignment = SEED_ASSIGNMENTS[idx % SEED_ASSIGNMENTS.length]!;
    const plan = pastePlanFor(idx, assignment);
    if (plan.kind !== 'clean') pasteBundles++;
    subs.push({
      folder: `submission_s${idx}`,
      assignmentId: assignment,
      submitters: [student],
      events: buildEvents(plan, student),
    });
  }

  const bundles = subs.filter((s) => s.assignmentId !== null);
  const stats: SeedStats = {
    roster: subs.reduce((n, s) => n + s.submitters.length, 0),
    bundles: bundles.length,
    submissionsQueued: bundles.reduce((n, s) => n + s.submitters.length, 0),
    skipped: subs.length - bundles.length,
    assignments: SEED_ASSIGNMENTS,
    pasteBundles,
    sharedClusters: SHARED_SNIPPETS.length,
  };
  return { subs, stats };
}

// ---------------------------------------------------------------------------
// ZIP assembly
// ---------------------------------------------------------------------------

const EXPORT_ROOT = 'assignment_seed_export/';

/** Render the Ruby-symbol `submission_metadata.yml` Gradescope emits. */
function renderMetadata(subs: SeedSubmission[]): string {
  let out = '';
  for (const sub of subs) {
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
  events: EventSpec[],
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: SEED_BUNDLE_SEMESTER,
    sessions: [{ events }],
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

/**
 * Build the full Gradescope export ZIP for a cohort of `studentCount` students.
 * Returns the ZIP bytes plus a summary of what's in it.
 */
export async function buildSeedExport(
  studentCount: number = SEED_STUDENT_COUNT,
): Promise<{ bytes: Uint8Array; stats: SeedStats }> {
  const { subs, stats } = planSubmissions(studentCount);

  const outer = new JSZip();
  outer.file(`${EXPORT_ROOT}submission_metadata.yml`, renderMetadata(subs));
  // A stray macOS file, to prove the loader ignores archive noise.
  outer.file(`${EXPORT_ROOT}.DS_Store`, new Uint8Array([0]));

  for (const sub of subs) {
    const prefix = `${EXPORT_ROOT}${sub.folder}/`;
    if (sub.assignmentId === null) {
      outer.file(`${prefix}answers.txt`, new TextEncoder().encode('submitted without recorder\n'));
    } else {
      await layBundleIntoFolder(outer, prefix, sub.assignmentId, sub.events);
    }
  }

  const buf = await outer.generateAsync({ type: 'arraybuffer' });
  return { bytes: new Uint8Array(buf), stats };
}
