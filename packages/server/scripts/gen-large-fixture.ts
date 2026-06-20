/**
 * Generate a large Gradescope-export test fixture: N students, each with ONE
 * faithful signed ~E-event `.provenance` bundle. Defaults: 700 students × 50,000
 * events (the "700 large bundles" throughput scenario).
 *
 * DEV TOOLING — not shipped server code. Produces the SAME flat-folder Gradescope
 * export shape the seed and `profile-large-bundle.ts` use (each submission is a
 * flat folder of the sealed bundle's files; `submission_metadata.yml` carries the
 * sid→folder mapping), and uses the SAME `@provenance/log-core` crypto core
 * (real ed25519 session key, hash-chained slog, signed checkpoints every 100
 * entries, signed manifest, exact final doc.save reconstruction) so every bundle
 * passes validation. The extension hash matches the analyzer allowlist.
 *
 *   npm run gen:fixture --workspace=packages/server
 *   npm run gen:fixture --workspace=packages/server -- --students 700 --events 50000 --out /tmp/fix.zip
 *
 * Memory-safe by construction: each ~E-event bundle (~16 MB at 50k) is built,
 * written to a staging directory on disk, and released before the next — so peak
 * heap is one bundle, not all N. The staging tree is then packaged with the
 * streaming system `zip` (no in-memory JSZip of the whole ~11 GB), and removed.
 *
 * Student sids are 200001..200000+N (matching the seed scheme). To INGEST the
 * fixture the target semester's roster must contain those sids and an `hw10`
 * assignment, else submissions land in the unmatched tray. The single batch can
 * exceed INGEST_MAX_BATCH_BYTES (default 5 GB) — raise it for the import.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  chainEntry,
  serializeEntry,
  sha256Hex,
  canonicalize,
  GENESIS_PREV_HASH,
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
  signBundleManifest,
  signManifest,
} from '@provenance/log-core';
import type { BundleManifest, SlogMeta, Checkpoint, Envelope, Range } from '@provenance/log-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASSIGNMENT = 'hw10';
const SEMESTER_STR = 'fa2026';
// Matches the analyzer's known-good-extension-hashes allowlist (same as the seed).
const EXTENSION_HASH = 'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';
const RECORDER_VERSION = '0.2.0';
const VSCODE_VERSION = '1.94.2';
const CHECKPOINT_INTERVAL = 100;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const EXPORT_ROOT = 'large_export';
const FIRST_NAMES = ['Avery', 'Blake', 'Casey', 'Drew', 'Emerson', 'Finley', 'Gray', 'Harper'];
const LAST_NAMES = ['Nguyen', 'Patel', 'Kim', 'Garcia', 'Olsen', 'Ibrahim', 'Romano', 'Chen'];

function log(msg: string): void {
  process.stdout.write(`[fixture] ${msg}\n`);
}

function parseArgs(argv: string[]): {
  students: number;
  events: number;
  out: string;
  seed: number;
} {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k?.startsWith('--')) a[k.slice(2)] = argv[i + 1] ?? '';
  }
  const students = Number(a['students'] ?? '700');
  const events = Number(a['events'] ?? '50000');
  const seed = Number(a['seed'] ?? '1');
  const out = a['out'] ?? path.join(__dirname, 'fixtures', `large-${students}x${events}.zip`);
  if (!Number.isInteger(students) || students < 1)
    throw new Error(`bad --students: ${a['students']}`);
  if (!Number.isInteger(events) || events < 100) throw new Error(`bad --events: ${a['events']}`);
  return { students, events, out, seed };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pos = { line: number; character: number };

/** Initial end position of `content` (one split, only at startup). */
function initEnd(content: string): Pos {
  const lines = content.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

/** Advance an end position by appended `text` — O(text), not O(content). The
 *  generator only ever appends, so the end position is tracked incrementally
 *  instead of re-splitting the whole (growing) file on every event (which is the
 *  O(n²) trap that made naive generation ~15s/bundle). */
function advanceEnd(end: Pos, text: string): void {
  const nl = text.lastIndexOf('\n');
  if (nl === -1) {
    end.character += text.length;
  } else {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) end.line++;
    end.character = text.length - nl - 1;
  }
}

/** A zero-width range at the current end position. */
function rangeAt(end: Pos): Range {
  const p = { line: end.line, character: end.character };
  return { start: p, end: { ...p } };
}

type EventSpec = { kind: string; data: Record<string, unknown> };

const MIX: ReadonlyArray<{ kind: string; w: number }> = [
  { kind: 'doc.change', w: 40 },
  { kind: 'selection.change', w: 38 },
  { kind: 'session.heartbeat', w: 8 },
  { kind: 'focus.change', w: 7 },
  { kind: 'git.event', w: 3 },
  { kind: 'terminal.open', w: 2 },
  { kind: 'doc.close', w: 2 },
];
const MIX_W = MIX.reduce((n, k) => n + k.w, 0);

interface Student {
  name: string;
  sid: string;
  email: string;
}

/**
 * Build one faithful sealed-bundle file set for a student (mirrors
 * profile-large-bundle.ts's crypto core), parameterized by event count, seed,
 * and student identity. Returns the flat files that go in the submission folder.
 */
async function buildBundleFiles(
  eventCount: number,
  courseSig: string,
  student: Student,
  seed: number,
): Promise<Record<string, string>> {
  const rng = mulberry32(seed);
  const keypair = await generateSessionKeypair();
  // Deterministic-but-unique session id per student.
  const sidHex = sha256Hex(`large-session:${student.sid}:${seed}`).slice(0, 32);
  const sessionId = `${sidHex.slice(0, 8)}-${sidHex.slice(8, 12)}-4${sidHex.slice(13, 16)}-8${sidHex.slice(17, 20)}-${sidHex.slice(20, 32)}`;
  const machineId = sha256Hex(`large-machine:${student.sid}`);
  const path0 = `${ASSIGNMENT}.py`;

  let content = `# ${ASSIGNMENT} — CS 61A\nfrom operator import add, mul\n\n\ndef solve(data):\n    pass\n`;
  const end = initEnd(content);
  let typed = 0;

  const startData = {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: null,
    assignment: { id: ASSIGNMENT, semester: SEMESTER_STR },
    manifest_sig: courseSig,
    machine_id: machineId,
    vscode: { version: VSCODE_VERSION, commit: '', platform: 'darwin' },
    recorder: { version: RECORDER_VERSION, extension_id: 'provenance.recorder' },
    session_pubkey: keypair.publicKeyHex,
  };

  const baseMs = Date.parse('2026-06-10T15:00:00.000Z');
  const avgGap = Math.max(1, Math.floor(FOUR_HOURS_MS / eventCount));
  let prevHash = GENESIS_PREV_HASH;
  let t = 0;
  let entryCount = 0;
  const lines: string[] = [];
  const checkpoints: Checkpoint[] = [];

  const append = async (
    seq: number,
    kind: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    const envelope = {
      seq,
      t,
      wall: new Date(baseMs + t).toISOString(),
      kind,
      data,
    } as unknown as Envelope;
    const entry = chainEntry(prevHash, envelope);
    lines.push(serializeEntry(entry).trimEnd());
    prevHash = entry.hash;
    entryCount++;
    if (entryCount % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push(await signCheckpoint(entry.seq, entry.hash, keypair.privateKey));
    }
  };

  const cosmetic = (kind: string): EventSpec => {
    switch (kind) {
      case 'selection.change':
        return { kind, data: { path: path0, range: rangeAt(end), was_selection: rng() < 0.4 } };
      case 'session.heartbeat':
        return { kind, data: { focused: true, active_file: path0, idle_since_ms: 0 } };
      case 'focus.change':
        return { kind, data: { gained: rng() < 0.5 } };
      case 'git.event':
        return { kind, data: { operation: rng() < 0.5 ? 'status' : 'diff' } };
      case 'doc.close':
        return { kind, data: { path: path0 } };
      default:
        return {
          kind: 'terminal.open',
          data: { terminal_id: 't1', shell: 'bash', shell_integration: true },
        };
    }
  };

  await append(0, 'session.start', startData);

  let seq = 1;
  t += avgGap;
  const openT = t;
  await append(seq++, 'doc.open', {
    path: path0,
    sha256: sha256Hex(content),
    line_count: content.split('\n').length,
    content,
    truncated: false,
  });

  const pasteAt1 = Math.floor(eventCount * 0.3);
  const pasteAt2 = Math.floor(eventCount * 0.7);
  for (let i = 0; i < eventCount; i++) {
    t += 1 + Math.floor(rng() * avgGap * 2);

    if (i === pasteAt1 || i === pasteAt2) {
      const blob =
        `# pasted helper block ${i}\n` +
        Array.from(
          { length: 20 },
          (_, j) => `    val_${i}_${j} = lookup(${j}) + offset(${i})`,
        ).join('\n') +
        '\n';
      const range = rangeAt(end);
      content += blob;
      advanceEnd(end, blob);
      await append(seq++, 'paste', {
        path: path0,
        range,
        length: blob.length,
        sha256: sha256Hex(blob),
        content: blob,
      });
      continue;
    }

    let r = rng() * MIX_W;
    let kind = MIX[MIX.length - 1]!.kind;
    for (const k of MIX) {
      if (r < k.w) {
        kind = k.kind;
        break;
      }
      r -= k.w;
    }
    if (kind === 'doc.change') {
      const range = rangeAt(end);
      const line = `    step_${typed} = transform(data[${typed % 50}], ${typed})\n`;
      content += line;
      advanceEnd(end, line);
      typed++;
      await append(seq++, 'doc.change', {
        path: path0,
        deltas: [{ range, text: line }],
        source: 'typed',
      });
    } else {
      const ev = cosmetic(kind);
      await append(seq++, ev.kind, ev.data);
    }
  }

  t = Math.max(t, openT + 35_000);
  await append(seq++, 'doc.save', { path: path0, sha256: sha256Hex(content) });

  const slogText = lines.join('\n') + '\n';
  const encryptedPrivkey = await encryptSessionPrivkey(keypair.privateKey, courseSig, sessionId);
  const meta: SlogMeta = {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: keypair.publicKeyHex,
    encrypted_session_privkey: encryptedPrivkey,
    checkpoints,
  };
  const metaJson = canonicalize(meta);

  const manifest: BundleManifest = {
    format_version: '1.1',
    assignment_id: ASSIGNMENT,
    semester: SEMESTER_STR,
    extension_hash: EXTENSION_HASH,
    sessions: [
      {
        session_id: sessionId,
        prev_session_id: null,
        slog_sha256: sha256Hex(slogText),
        meta_sha256: sha256Hex(metaJson),
      },
    ],
    submission_files: [{ path: path0, status: 'present', sha256: sha256Hex(content) }],
  };
  const signed = await signBundleManifest(manifest, keypair.privateKey);

  return {
    'manifest.json': signed.canonicalJson,
    'manifest.sig': signed.signatureHex,
    [`session-${sessionId}.slog`]: slogText,
    [`session-${sessionId}.slog.meta`]: metaJson,
    [path0]: content,
  };
}

function makeStudent(i: number): Student {
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const sid = String(200001 + i);
  return {
    name: `${first} ${last}`,
    sid,
    email: `${first}.${last}.${sid}@berkeley.edu`.toLowerCase(),
  };
}

function runZip(cwd: string, outAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -1 = fastest compression (the slog hashes are high-entropy and barely
    // compress anyway); -r recurse, -q quiet, -X strip extra metadata.
    const zip = spawn('zip', ['-r', '-1', '-q', '-X', outAbs, EXPORT_ROOT], {
      cwd,
      stdio: 'inherit',
    });
    zip.on('error', reject);
    zip.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
  });
}

async function main(): Promise<void> {
  const { students, events, out, seed } = parseArgs(process.argv.slice(2));
  const outAbs = path.resolve(out);
  const staging = path.join(path.dirname(outAbs), `.fixture-staging-${process.pid}`);
  const rootDir = path.join(staging, EXPORT_ROOT);

  log(`generating ${students} students × ${events.toLocaleString()} events → ${outAbs}`);
  const tStart = Date.now();

  await rm(staging, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await mkdir(path.dirname(outAbs), { recursive: true });
  await rm(outAbs, { force: true });

  // One course keypair + signed course manifest shared by every student (the
  // course-level manifest_sig the recorder embeds), each student a fresh session key.
  const courseKeypair = await generateSessionKeypair();
  const courseSig = await signManifest(
    {
      assignment_id: ASSIGNMENT,
      semester: SEMESTER_STR,
      issued_at: '2026-01-01T00:00:00.000Z',
      files_under_review: [`${ASSIGNMENT}.py`],
    },
    courseKeypair.privateKey,
  );

  const subs: Student[] = [];
  let metaYml = '';
  for (let i = 0; i < students; i++) {
    const student = makeStudent(i);
    subs.push(student);
    const folder = `submission_${student.sid}`;
    const files = await buildBundleFiles(events, courseSig, student, seed + i);

    const dir = path.join(rootDir, folder);
    await mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents);
    }
    metaYml += `${folder}:\n  :submitters:\n  - :name: ${student.name}\n    :sid: '${student.sid}'\n    :email: ${student.email}\n`;

    if ((i + 1) % 25 === 0 || i + 1 === students) {
      const elapsed = (Date.now() - tStart) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (students - (i + 1)) / rate;
      log(`  ${i + 1}/${students} bundles (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`);
    }
  }

  await writeFile(path.join(rootDir, 'submission_metadata.yml'), metaYml);

  log(`packaging ${subs.length} submissions with system zip…`);
  await runZip(staging, outAbs);
  await rm(staging, { recursive: true, force: true });

  const { stat } = await import('node:fs/promises');
  const sz = (await stat(outAbs)).size;
  log('');
  log(`DONE in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
  log(`fixture: ${outAbs}`);
  log(
    `size: ${(sz / 1024 / 1024).toFixed(0)} MB  (${students} students × ${events.toLocaleString()} events)`,
  );
  log(`sids: 200001..${200000 + students}, assignment '${ASSIGNMENT}', semester '${SEMESTER_STR}'`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[fixture] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
