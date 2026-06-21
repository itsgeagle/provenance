/**
 * bench-stages — empirical time-complexity probe for the CPU-bound ingest stages.
 *
 * DEV TOOLING — not shipped server code. Unlike `profile:large` (which runs the
 * full route + worker against Postgres/MinIO), this needs NO infra: it generates
 * one faithful signed bundle at a sweep of event counts and times the pure
 * pipeline stages in-process:
 *
 *   parse (loadBundle: unzip + JCS hash-chain verify + ed25519)
 *   buildIndex      (flatten + sort + single-pass maps)
 *   computeStats    (per-file walk + per-file reconstruction taint)
 *   runValidation   (8 checks; chain + submitted-code reconstruction)
 *   runHeuristics   (~19 detectors over the index)
 *
 * It prints absolute ms per stage AND ms-normalized-per-10k-events. A flat
 * normalized column ⇒ linear; a rising one ⇒ super-linear. DB/S3/crypto round
 * trips are excluded by design — they are linear I/O and measured elsewhere.
 *
 *   npm run bench:stages --workspace=packages/server
 *   npm run bench:stages --workspace=packages/server -- 1000 5000 10000 50000 100000
 */

import JSZip from 'jszip';
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

import { loadBundle } from '@provenance/analyzer/src/loader/parse-bundle.js';
import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { computeStats } from '@provenance/analyzer/src/index/stats.js';
import { runValidation } from '@provenance/analyzer/src/validation/run-validation.js';
import { runHeuristics } from '@provenance/analyzer/src/heuristics/run-heuristics.js';
import type { Bundle } from '@provenance/analyzer/src/loader/types.js';
// Per-check breakdown (BENCH_CHECKS=1): the 8 validation checks in spec order.
import { verifyManifestSig } from '@provenance/analyzer/src/validation/verify-manifest-sig.js';
import { verifySessionBinding } from '@provenance/analyzer/src/validation/verify-session-binding.js';
import { verifyChain } from '@provenance/analyzer/src/validation/verify-chain.js';
import { verifySeq } from '@provenance/analyzer/src/validation/verify-seq.js';
import { verifyMonotonicT } from '@provenance/analyzer/src/validation/verify-monotonic-t.js';
import { verifyMonotonicWall } from '@provenance/analyzer/src/validation/verify-monotonic-wall.js';
import { verifyDocSaveHashes } from '@provenance/analyzer/src/validation/verify-doc-save-hashes.js';
import { verifySubmittedCode } from '@provenance/analyzer/src/validation/verify-submitted-code.js';

const ASSIGNMENT = 'hw10';
const SEMESTER_STR = 'fa2026';
const EXTENSION_HASH = 'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';
const RECORDER_VERSION = '0.2.0';
const VSCODE_VERSION = '1.94.2';
const CHECKPOINT_INTERVAL = 100;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
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
function initEnd(content: string): Pos {
  const lines = content.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}
function advanceEnd(end: Pos, text: string): void {
  const nl = text.lastIndexOf('\n');
  if (nl === -1) {
    end.character += text.length;
  } else {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) end.line++;
    end.character = text.length - nl - 1;
  }
}
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

/** Faithful single-session bundle file set (mirrors gen-large-fixture's core). */
async function buildBundleFiles(eventCount: number, courseSig: string): Promise<Record<string, string>> {
  const rng = mulberry32(0xc0ffee);
  const keypair = await generateSessionKeypair();
  const sessionId = '0e33e8dd-584e-4f24-8262-b948264f0001';
  const machineId = sha256Hex('bench-machine');
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

  const append = async (seq: number, kind: string, data: Record<string, unknown>): Promise<void> => {
    const envelope = { seq, t, wall: new Date(baseMs + t).toISOString(), kind, data } as unknown as Envelope;
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
        return { kind: 'terminal.open', data: { terminal_id: 't1', shell: 'bash', shell_integration: true } };
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
        Array.from({ length: 20 }, (_, j) => `    val_${i}_${j} = lookup(${j}) + offset(${i})`).join('\n') +
        '\n';
      const range = rangeAt(end);
      content += blob;
      advanceEnd(end, blob);
      await append(seq++, 'paste', { path: path0, range, length: blob.length, sha256: sha256Hex(blob), content: blob });
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
      await append(seq++, 'doc.change', { path: path0, deltas: [{ range, text: line }], source: 'typed' });
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
      { session_id: sessionId, prev_session_id: null, slog_sha256: sha256Hex(slogText), meta_sha256: sha256Hex(metaJson) },
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

async function buildZip(eventCount: number): Promise<{ bytes: ArrayBuffer; slogBytes: number }> {
  const courseKeypair = await generateSessionKeypair();
  const courseSig = await signManifest(
    { assignment_id: ASSIGNMENT, semester: SEMESTER_STR, issued_at: '2026-01-01T00:00:00.000Z', files_under_review: [`${ASSIGNMENT}.py`] },
    courseKeypair.privateKey,
  );
  const files = await buildBundleFiles(eventCount, courseSig);
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(files)) zip.file(name, contents);
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const slogKey = Object.keys(files).find((k) => k.endsWith('.slog'))!;
  return { bytes, slogBytes: files[slogKey]!.length };
}

/** Median of repeated timings of `fn` (ms). Returns [medianMs, result]. */
async function timeIt<T>(reps: number, fn: () => T | Promise<T>): Promise<[number, T]> {
  const samples: number[] = [];
  let last!: T;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    last = await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(samples.length / 2)]!, last];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

async function main(): Promise<void> {
  const argSizes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n >= 100);
  const sizes = argSizes.length > 0 ? argSizes : [1000, 2000, 5000, 10000, 25000, 50000, 100000];
  const reps = 3;

  log(`bench-stages — median of ${reps} reps per stage, no DB/S3. Node ${process.version}\n`);

  type Row = { n: number; events: number; slogMB: number; parse: number; index: number; stats: number; validation: number; heuristics: number };
  const rows: Row[] = [];

  for (const n of sizes) {
    const { bytes, slogBytes } = await buildZip(n);

    // parse: loadBundle from the zip bytes (fresh copy each rep — loadBundle may consume).
    const [parseMs, parsed] = await timeIt(reps, async () => {
      const res = await loadBundle(bytes.slice(0), `${ASSIGNMENT}_200001.zip`);
      if (!res.ok) throw new Error(`loadBundle failed: ${res.error.kind}`);
      return res.value as Bundle;
    });

    const realEvents = parsed.sessions.reduce((acc, s) => acc + s.events.length, 0);

    const [indexMs, index] = await timeIt(reps, () => buildIndex(parsed));
    const [statsMs] = await timeIt(reps, () => computeStats(index));
    const [valMs, report] = await timeIt(reps, () => runValidation(parsed));
    const [heurMs] = await timeIt(reps, () => runHeuristics(index, parsed, report));

    // Optional per-check breakdown of the dominant validation stage.
    if (process.env['BENCH_CHECKS'] === '1') {
      const checks: Array<[string, () => unknown]> = [
        ['1 manifest_sig', () => verifyManifestSig(parsed)],
        ['2 session_bind', () => verifySessionBinding(parsed)],
        ['3 chain', () => verifyChain(parsed)],
        ['4 seq', () => verifySeq(parsed)],
        ['5 monotonic_t', () => verifyMonotonicT(parsed)],
        ['6 monotonic_wall', () => verifyMonotonicWall(parsed)],
        ['7 doc_save_hash', () => verifyDocSaveHashes(parsed)],
        ['8 submitted_code', () => verifySubmittedCode(parsed, { chainIntact: true })],
      ];
      const parts: string[] = [];
      for (const [name, fn] of checks) {
        const [ms] = await timeIt(reps, fn);
        parts.push(`${name}=${ms.toFixed(1)}`);
      }
      log(`    validation checks @${realEvents}: ${parts.join('  ')}`);
    }

    rows.push({
      n,
      events: realEvents,
      slogMB: slogBytes / 1024 / 1024,
      parse: parseMs,
      index: indexMs,
      stats: statsMs,
      validation: valMs,
      heuristics: heurMs,
    });
    log(`  ${padL(n.toLocaleString(), 9)} events done`);
  }

  // ---- Absolute table ----
  log('\nAbsolute median ms per stage:\n');
  const head = ['events', 'slogMB', 'parse', 'buildIdx', 'stats', 'valid', 'heur', 'CPU sum'];
  log(pad(head[0]!, 9) + head.slice(1).map((h) => padL(h, 10)).join(''));
  for (const r of rows) {
    const sum = r.parse + r.index + r.stats + r.validation + r.heuristics;
    log(
      pad(r.events.toLocaleString(), 9) +
        padL(r.slogMB.toFixed(1), 10) +
        padL(r.parse.toFixed(1), 10) +
        padL(r.index.toFixed(1), 10) +
        padL(r.stats.toFixed(1), 10) +
        padL(r.validation.toFixed(1), 10) +
        padL(r.heuristics.toFixed(1), 10) +
        padL(sum.toFixed(1), 10),
    );
  }

  // ---- Normalized (ms per 10k events) — flat ⇒ linear, rising ⇒ super-linear ----
  log('\nNormalized ms per 10k events (flat = linear, rising = super-linear):\n');
  log(pad('events', 9) + ['parse', 'buildIdx', 'stats', 'valid', 'heur', 'CPU sum'].map((h) => padL(h, 10)).join(''));
  for (const r of rows) {
    const f = 10000 / r.events;
    const sum = r.parse + r.index + r.stats + r.validation + r.heuristics;
    log(
      pad(r.events.toLocaleString(), 9) +
        padL((r.parse * f).toFixed(2), 10) +
        padL((r.index * f).toFixed(2), 10) +
        padL((r.stats * f).toFixed(2), 10) +
        padL((r.validation * f).toFixed(2), 10) +
        padL((r.heuristics * f).toFixed(2), 10) +
        padL((sum * f).toFixed(2), 10),
    );
  }
  log('');
}

main().catch((err: unknown) => {
  process.stderr.write(`bench-stages failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
