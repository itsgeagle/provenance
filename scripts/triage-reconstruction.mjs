#!/usr/bin/env node
/**
 * Read-only triage for file reconstruction across a corpus of submission bundles.
 *
 * WHY THIS EXISTS
 * ---------------
 * The analyzer's current replay (`reconstructFile` in analysis-core) throws away
 * recoverable history in three independent ways. See
 * `.notes/reconstruction-triage.md` for the full write-up. Summary:
 *
 *   D1  The recorder emits false `fs.external_change` events for the student's
 *       OWN autosave (a race in doc-wiring.ts between onDidSaveTextDocument and
 *       the async readFile). Signature: the event is immediately followed by a
 *       doc.save whose sha256 === the event's new_hash, at the same wall clock.
 *   D2  `reconstructFile` treats any fs.external_change without inline
 *       `new_content` as a permanent taint: content is zeroed and every later
 *       doc.change is skipped, with no untaint path. `new_content` is only
 *       inlined for files <= 4 KB, so any real-sized source file taints on the
 *       first D1 false positive and stays dead for the rest of the bundle.
 *   D3  The same file recorded from two different workspace roots lands under
 *       two different relative paths ("hw.py" and "sub/hw.py") and is indexed as
 *       two unrelated files, orphaning every event from the shallower root.
 *
 * Plus a loader-level one:
 *
 *   D4  `loadBundle` rejects the whole ZIP with `unexpected_file` if it contains
 *       any entry not in the manifest — including harmless LMS-injected files.
 *
 * This script quantifies the blast radius. For every bundle it runs the replay
 * TWICE — once reproducing today's analyzer behaviour (the baseline), once with
 * the repairs applied — and reports which submissions change verdict.
 *
 * WHY THE RESULT IS TRUSTWORTHY
 * -----------------------------
 * The repair is not guesswork. Each bundle carries two independent oracles:
 *   - the signed manifest's per-file sha256 (the final answer), and
 *   - every doc.save event's recorded sha256 (hundreds of intermediate
 *     checkpoints).
 * A repaired replay is only reported as recovered when it reproduces the signed
 * manifest hash exactly. The checkpoint rate is reported alongside so a partial
 * recovery is never mistaken for a clean one.
 *
 * This script NEVER writes to, re-signs, or otherwise mutates a bundle. It only
 * reads. `--json` is the sole write, and only to the path you name.
 *
 * USAGE
 *   node scripts/triage-reconstruction.mjs <path>...  [options]
 *
 *   <path>    A .zip bundle, or a directory to scan (recursively) for .zip files.
 *
 *   --json <file>   Write the full per-bundle report as JSON.
 *   --verbose       Print a per-file breakdown for every bundle, not just the
 *                   ones whose verdict changes.
 *   --quiet         Suppress the per-bundle lines; print only the summary.
 *
 * Requires `npm run build` (or at least a built packages/analysis-core/dist).
 * Run from the repo root so the workspace package resolves.
 *
 * PRIVACY: prints only paths, hashes, counts and verdicts. It never emits file
 * contents, event payloads, or bundle metadata (names, emails, submission ids).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

let analysisCore;
try {
  analysisCore = await import('@provenance/analysis-core');
} catch (e) {
  console.error(
    'Could not import @provenance/analysis-core.\n' +
      'Run `npm run build` first, and run this script from the repo root.\n' +
      `Underlying error: ${e.message}`,
  );
  process.exit(2);
}
const { loadBundle, buildIndex, applyDocChange, applyPaste, reconstructFile } = analysisCore;
const { default: JSZip } = await import('jszip');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const paths = [];
  const opts = { json: null, verbose: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else paths.push(a);
  }
  return { paths, opts };
}

function collectZips(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (extname(p).toLowerCase() === '.zip') {
      out.push(p);
    }
  };
  for (const p of paths) walk(p);
  return out.sort();
}

// ---------------------------------------------------------------------------
// D4 workaround: strip entries the loader would reject, so triage can proceed.
//
// We rebuild a ZIP containing only entries loadBundle recognises. Nothing is
// written to disk and the original file is untouched — the filtered bytes exist
// only in memory for this process.
// ---------------------------------------------------------------------------

const BUNDLE_FILE_RE = /^(manifest\.json|manifest\.sig|session-[^/]+\.slog(\.meta)?)$/;

async function filterUnexpectedEntries(bytes) {
  const zip = await JSZip.loadAsync(bytes);

  // The manifest tells us which non-log entries are legitimate submission files.
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) return { bytes, dropped: [] };
  let submissionPaths = new Set();
  try {
    const manifest = JSON.parse(await manifestEntry.async('string'));
    for (const f of manifest.submission_files ?? []) submissionPaths.add(f.path);
  } catch {
    return { bytes, dropped: [] };
  }

  const dropped = [];
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (BUNDLE_FILE_RE.test(name) || submissionPaths.has(name)) {
      out.file(name, await entry.async('uint8array'));
    } else {
      dropped.push(name);
    }
  }
  if (dropped.length === 0) return { bytes, dropped };
  const rebuilt = await out.generateAsync({ type: 'uint8array' });
  return { bytes: rebuilt, dropped };
}

// ---------------------------------------------------------------------------
// Path aliasing (D3)
//
// A file recorded from a shallower workspace root appears with a directory
// prefix. "hw.py" and "sub/hw.py" are the same file seen from two roots.
//
// This is a *candidate* relationship, not a certainty — a genuinely different
// file could share a basename. We never assume: both the aliased and un-aliased
// replays are run, and whichever reproduces the signed manifest hash wins. The
// manifest is the arbiter, so a wrong guess can't silently corrupt a verdict.
// ---------------------------------------------------------------------------

function aliasCandidates(index, manifestPath) {
  const keys = [...index.byFile.keys()];
  return keys.filter((k) => k === manifestPath || k.endsWith('/' + manifestPath));
}

function mergeEvents(index, keys) {
  return keys.flatMap((k) => index.byFile.get(k) ?? []).sort((a, b) => a.globalIdx - b.globalIdx);
}

// ---------------------------------------------------------------------------
// D1 discriminator: is this fs.external_change the recorder reacting to the
// student's own save?
//
// Deliberately narrow. A genuine external write (git checkout, an AI tool
// rewriting the file) is the single most important integrity signal in the
// system, and must never be suppressed. All four conditions must hold:
//   - the very next event for this file is a doc.save,
//   - in the same session,
//   - whose recorded sha256 equals this event's new_hash, and
//   - within 1s of wall clock.
// A real external write followed by a save would have to coincidentally produce
// the identical hash within a second to be misclassified.
// ---------------------------------------------------------------------------

const SELF_INFLICTED_WINDOW_MS = 1000;

function isSelfInflicted(events, i) {
  const e = events[i];
  const next = events[i + 1];
  if (!next || next.kind !== 'doc.save') return false;
  if (next.sessionId !== e.sessionId) return false;
  if ((e.payload?.operation ?? 'modify') !== 'modify') return false;
  if (next.payload?.sha256 !== e.payload?.new_hash) return false;
  const dt = Math.abs(Date.parse(next.wall) - Date.parse(e.wall));
  return Number.isFinite(dt) && dt <= SELF_INFLICTED_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Repaired replay
//
// Differences from analysis-core's reconstructFile:
//   - self-inflicted fs.external_change events are skipped entirely (D1)
//   - a genuine fs.external_change WITHOUT new_content records a gap but does
//     not permanently kill the replay; the next doc.open re-anchors it (D2)
//   - doc.open always re-anchors from its inlined content (D2)
//   - pastes are applied via applyPaste's {content, applied} result
// ---------------------------------------------------------------------------

function repairedReplay(events) {
  let content = '';
  let anchors = 0;
  let checkpoints = 0;
  let checkpointHits = 0;
  let selfInflicted = 0;
  let genuineReseeded = 0;
  let genuineGaps = 0;
  let gapOpenSinceAnchor = false;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    switch (e.kind) {
      case 'doc.open':
        if (typeof e.payload?.content === 'string') {
          content = e.payload.content;
          anchors++;
          gapOpenSinceAnchor = false;
        }
        break;
      case 'doc.change':
        content = applyDocChange(content, e.payload);
        break;
      case 'paste': {
        const r = applyPaste(content, e.payload);
        if (r?.applied) content = r.content;
        else gapOpenSinceAnchor = true; // large paste, no inline content
        break;
      }
      case 'fs.external_change': {
        if (isSelfInflicted(events, i)) {
          selfInflicted++;
          break;
        }
        if (typeof e.payload?.new_content === 'string') {
          content = e.payload.new_content;
          genuineReseeded++;
        } else {
          genuineGaps++;
          gapOpenSinceAnchor = true;
        }
        break;
      }
      case 'doc.save': {
        const want = e.payload?.sha256;
        if (typeof want === 'string') {
          checkpoints++;
          if (sha256(content) === want) checkpointHits++;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    content,
    anchors,
    checkpoints,
    checkpointHits,
    selfInflicted,
    genuineReseeded,
    genuineGaps,
    gapOpenAtEnd: gapOpenSinceAnchor,
  };
}

// ---------------------------------------------------------------------------
// Per-bundle triage
// ---------------------------------------------------------------------------

async function triageBundle(zipPath) {
  const raw = readFileSync(zipPath);
  const rawBytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  // Does it load as-is? (D4 detection: we care whether the stock loader accepts it.)
  const asIs = await loadBundle(rawBytes, basename(zipPath)).catch((e) => ({
    ok: false,
    error: { kind: 'threw', detail: String(e?.message ?? e) },
  }));

  let bundle = null;
  let droppedEntries = [];
  let loaderRejectedStock = false;

  if (asIs.ok) {
    bundle = asIs.value;
  } else {
    loaderRejectedStock = true;
    const filtered = await filterUnexpectedEntries(raw);
    droppedEntries = filtered.dropped;
    const retry = await loadBundle(
      filtered.bytes.buffer.slice(
        filtered.bytes.byteOffset,
        filtered.bytes.byteOffset + filtered.bytes.byteLength,
      ),
      basename(zipPath),
    ).catch((e) => ({ ok: false, error: { kind: 'threw', detail: String(e?.message ?? e) } }));
    if (!retry.ok) {
      return {
        bundle: basename(zipPath),
        verdict: 'load-failed',
        loaderRejectedStock,
        droppedEntries,
        error: retry.error,
        files: [],
      };
    }
    bundle = retry.value;
  }

  const index = buildIndex(bundle);
  const files = [];

  for (const sf of bundle.manifest.submission_files ?? []) {
    if (sf.status !== 'present' || typeof sf.sha256 !== 'string') continue;

    // --- Baseline: exactly what the analyzer produces today.
    const base = reconstructFile(index, sf.path);
    const baselineMatch = sha256(base.content) === sf.sha256;

    // --- Repaired: try un-aliased first, then aliased. Manifest hash arbitrates.
    const aliases = aliasCandidates(index, sf.path);
    const attempts = [];
    const soloKeys = index.byFile.has(sf.path) ? [sf.path] : [];
    if (soloKeys.length) attempts.push({ keys: soloKeys, label: 'exact-path' });
    if (aliases.length > soloKeys.length) attempts.push({ keys: aliases, label: 'merged-aliases' });

    let best = null;
    for (const attempt of attempts) {
      const r = repairedReplay(mergeEvents(index, attempt.keys));
      const match = sha256(r.content) === sf.sha256;
      const rate = r.checkpoints ? r.checkpointHits / r.checkpoints : 0;
      const scored = { ...r, ...attempt, match, rate };
      if (!best) best = scored;
      // Prefer an exact manifest match; otherwise the better checkpoint rate.
      else if ((match && !best.match) || (match === best.match && rate > best.rate)) best = scored;
    }

    if (!best) {
      files.push({
        path: sf.path,
        verdict: 'no-events',
        baselineMatch: false,
        repairedMatch: false,
      });
      continue;
    }

    let verdict;
    if (best.match) verdict = baselineMatch ? 'already-ok' : 'recovered';
    else if (best.genuineGaps > 0 || best.gapOpenAtEnd) verdict = 'gapped';
    else verdict = 'unrecovered';

    files.push({
      path: sf.path,
      verdict,
      baselineMatch,
      baselineTainted: base.tainted,
      baselineLen: base.content.length,
      repairedMatch: best.match,
      repairedLen: best.content.length,
      aliasStrategy: best.label,
      aliasCount: aliases.length,
      checkpoints: best.checkpoints,
      checkpointHits: best.checkpointHits,
      checkpointRate: best.checkpoints
        ? +(best.checkpointHits / best.checkpoints).toFixed(4)
        : null,
      docOpenAnchors: best.anchors,
      extSelfInflicted: best.selfInflicted,
      extGenuineReseeded: best.genuineReseeded,
      extGenuineGaps: best.genuineGaps,
    });
  }

  // Bundle verdict = worst file verdict.
  const RANK = {
    'already-ok': 0,
    recovered: 1,
    gapped: 2,
    unrecovered: 3,
    'no-events': 3,
  };
  const verdict = files.length
    ? files.reduce((w, f) => (RANK[f.verdict] > RANK[w] ? f.verdict : w), 'already-ok')
    : 'no-submission-files';

  return {
    bundle: basename(zipPath),
    verdict,
    loaderRejectedStock,
    droppedEntries,
    sessionCount: bundle.sessions.length,
    files,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const LABEL = {
  'already-ok': 'OK       ',
  recovered: 'RECOVERED',
  gapped: 'GAPPED   ',
  unrecovered: 'FAILED   ',
  'load-failed': 'LOADFAIL ',
  'no-submission-files': 'NO-FILES ',
};

function printBundle(r, opts) {
  if (opts.quiet) return;
  const interesting = r.verdict !== 'already-ok';
  if (!interesting && !opts.verbose) return;

  console.log(`${LABEL[r.verdict] ?? r.verdict}  ${r.bundle}`);
  if (r.verdict === 'load-failed') {
    console.log(`    loader error: ${JSON.stringify(r.error)}`);
    return;
  }
  if (r.loaderRejectedStock) {
    console.log(
      `    ! stock loader rejected this ZIP; ignored non-bundle entries: ${r.droppedEntries.join(', ')}`,
    );
  }
  for (const f of r.files) {
    if (f.verdict === 'already-ok' && !opts.verbose) continue;
    const rate = f.checkpointRate === null ? 'n/a' : `${(f.checkpointRate * 100).toFixed(1)}%`;
    console.log(
      `    ${f.path}: ${f.verdict}` +
        ` | baseline=${f.baselineMatch ? 'match' : `MISMATCH(len=${f.baselineLen}${f.baselineTainted ? ',tainted' : ''})`}` +
        ` | repaired=${f.repairedMatch ? 'match' : 'MISMATCH'}` +
        ` | checkpoints=${f.checkpointHits}/${f.checkpoints} (${rate})`,
    );
    const bits = [];
    if (f.aliasStrategy === 'merged-aliases') bits.push(`merged ${f.aliasCount} path aliases (D3)`);
    if (f.extSelfInflicted) bits.push(`${f.extSelfInflicted} self-inflicted ext-change (D1)`);
    if (f.extGenuineReseeded) bits.push(`${f.extGenuineReseeded} genuine ext-change, reseeded`);
    if (f.extGenuineGaps)
      bits.push(`${f.extGenuineGaps} genuine ext-change, NO CONTENT (real gap)`);
    if (bits.length) console.log(`        ${bits.join('; ')}`);
  }
}

function printSummary(results) {
  const byVerdict = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;

  const totalFiles = results.flatMap((r) => r.files);
  const brokenNow = totalFiles.filter((f) => !f.baselineMatch).length;
  const fixedByRepair = totalFiles.filter((f) => !f.baselineMatch && f.repairedMatch).length;
  const stillBroken = totalFiles.filter((f) => !f.baselineMatch && !f.repairedMatch).length;
  const realGaps = totalFiles.reduce((n, f) => n + (f.extGenuineGaps ?? 0), 0);
  const falsePositives = totalFiles.reduce((n, f) => n + (f.extSelfInflicted ?? 0), 0);
  const aliased = totalFiles.filter((f) => f.aliasStrategy === 'merged-aliases').length;
  const loaderRejects = results.filter((r) => r.loaderRejectedStock).length;

  console.log('\n' + '='.repeat(72));
  console.log('SUMMARY');
  console.log('='.repeat(72));
  console.log(`bundles scanned            : ${results.length}`);
  for (const [v, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(LABEL[v] ?? v).trim().padEnd(22)} : ${n}`);
  }
  console.log(`\nsubmission files checked   : ${totalFiles.length}`);
  console.log(`  broken today (baseline)  : ${brokenNow}`);
  console.log(`  recovered by repair      : ${fixedByRepair}`);
  console.log(`  still broken after repair: ${stillBroken}`);
  console.log(`\nfalse ext-changes (D1)     : ${falsePositives}`);
  console.log(`genuine gaps, no content   : ${realGaps}`);
  console.log(`files needing alias merge  : ${aliased}   (D3)`);
  console.log(`ZIPs stock loader rejects  : ${loaderRejects}   (D4)`);
  if (brokenNow > 0) {
    console.log(
      `\nrecovery rate: ${((100 * fixedByRepair) / brokenNow).toFixed(1)}% of currently-broken files ` +
        `reproduce their signed manifest hash exactly after repair.`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const { paths, opts } = parseArgs(process.argv.slice(2));

if (opts.help || paths.length === 0) {
  console.log(
    'Usage: node scripts/triage-reconstruction.mjs <zip-or-dir>... [--json out.json] [--verbose] [--quiet]',
  );
  process.exit(paths.length === 0 && !opts.help ? 1 : 0);
}

const zips = collectZips(paths);
if (zips.length === 0) {
  console.error('No .zip files found in the given paths.');
  process.exit(1);
}
console.error(`Triaging ${zips.length} bundle(s)...\n`);

const results = [];
for (const z of zips) {
  try {
    const r = await triageBundle(z);
    results.push(r);
    printBundle(r, opts);
  } catch (e) {
    const r = {
      bundle: basename(z),
      verdict: 'load-failed',
      // Message only — a corpus-wide run should stay readable. Re-run the one
      // bundle with NODE_OPTIONS=--stack-trace-limit=50 if you need the stack.
      error: { kind: 'threw', detail: String(e?.message ?? e) },
      files: [],
    };
    results.push(r);
    printBundle(r, opts);
  }
}

printSummary(results);

if (opts.json) {
  writeFileSync(opts.json, JSON.stringify(results, null, 2));
  console.log(`\nFull report written to ${opts.json}`);
}
