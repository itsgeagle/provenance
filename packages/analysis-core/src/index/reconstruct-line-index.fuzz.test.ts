/**
 * Differential fuzz test for the incremental line-index refactor (lever 1 of
 * the ingest-perf work — see `.notes/ingest-perf-investigation.md`).
 *
 * The hot reconstruction loops in `reconstruct-file.ts` and
 * `reconstruct-file-provenance.ts` were changed from `content.split('\n')`-
 * per-lookup (O(n²)) to an incrementally-maintained `lineStarts` index (O(1)
 * lookup) with in-place provenance mutation. Both reconstructors now share that
 * `lineStarts` model, so a bug introduced identically in both would slip past
 * the existing v1↔provenance parity test (which used to cross-check two
 * independent `split`-based implementations).
 *
 * This test restores an INDEPENDENT cross-check: it replays thousands of
 * seeded-random edit streams through the production reconstructors and asserts
 * byte-identical `content` (and identical per-character `provenance`) against an
 * oracle built from the *old* algorithm — the `split('\n')`-based
 * `positionToOffset` plus the untouched, still-exported pure
 * `spliceWithProvenance` helper. Those two together are exactly the pre-refactor
 * code path, computed without any `lineStarts`, so agreement proves the refactor
 * preserved semantics on the edit shapes the fixture tests under-exercise:
 * multi-line initial content, newlines inside inserted text, deletes/replaces
 * spanning newlines, mid-document edits (which shift following line starts), and
 * out-of-range positions that must clamp.
 *
 * Determinism: a hand-rolled LCG seeded per stream (the repo forbids
 * `Math.random()` in tests). Same seed → same streams → same assertions.
 */

import { describe, it, expect } from 'vitest';
import { reconstructFile } from './reconstruct-file.js';
import {
  reconstructFileWithProvenance,
  spliceWithProvenance,
} from './reconstruct-file-provenance.js';
import type { EventIndex, IndexedEvent } from './event-index.js';

const FILE = '/fuzz/file.py';

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG, Numerical Recipes constants)
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  // inclusive lo, exclusive hi
  return lo + Math.floor(rng() * (hi - lo));
}

// ---------------------------------------------------------------------------
// Oracle: the OLD reconstruction algorithm (independent of `lineStarts`)
// ---------------------------------------------------------------------------

/** Pre-refactor positionToOffset — re-splits the whole content every call. */
function offsetOld(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let l = 0; l < line && l < lines.length; l++) {
    offset += (lines[l]?.length ?? 0) + 1; // +1 for the '\n'
  }
  const targetLine = lines[line] ?? '';
  offset += Math.min(character, targetLine.length);
  return Math.min(offset, content.length);
}

/** Flat offset → (line, character), counting newlines (used only by the generator). */
function toPos(content: string, off: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < off; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: off - lineStart };
}

const ALPHABET = 'ab \nxyz(){}\n;';

function randText(rng: () => number): string {
  const len = randInt(rng, 0, 7);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randInt(rng, 0, ALPHABET.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Minimal EventIndex — the reconstructors only read `index.byFile`.
// ---------------------------------------------------------------------------

function makeIndex(events: IndexedEvent[]): EventIndex {
  const byFile = new Map<string, IndexedEvent[]>();
  for (const e of events) {
    if (e.file === undefined) continue;
    let arr = byFile.get(e.file);
    if (!arr) {
      arr = [];
      byFile.set(e.file, arr);
    }
    arr.push(e);
  }
  return {
    bySeq: new Map(),
    byKind: new Map(),
    byFile,
    bySessionId: new Map(),
    ordered: events,
  };
}

type GeneratedStream = {
  events: IndexedEvent[];
  /** Oracle content after applying events[0..i]. `contentAfter[-1]` is the seed. */
  contentAfter: string[];
  /** Oracle provenance for the FINAL state. */
  finalProvenance: number[];
  finalContent: string;
};

/**
 * Generate one random edit stream AND its oracle content/provenance in a single
 * naive pass. Edits are chosen in offset space (guaranteeing `start <= end`,
 * matching VS Code, which never emits inverted ranges), then converted to
 * (line, character) positions for the event payload — with a chance of pushing a
 * position out of range so the clamp paths get exercised.
 */
function generateStream(seed: number): GeneratedStream {
  const rng = makeRng(seed);
  const events: IndexedEvent[] = [];
  const contentAfter: string[] = [];

  let content = '';
  let prov: number[] = [];
  let globalIdx = 0;

  // ~40% of streams start by seeding multi-line initial content via doc.open.
  if (rng() < 0.4) {
    const lineCount = randInt(rng, 0, 5);
    let seedText = '';
    for (let l = 0; l < lineCount; l++) seedText += randText(rng) + '\n';
    seedText += randText(rng);
    content = seedText;
    prov = new Array<number>(seedText.length).fill(globalIdx);
    events.push({
      sessionId: 's',
      seq: globalIdx,
      globalIdx,
      wall: '',
      t: globalIdx,
      kind: 'doc.open',
      payload: { path: FILE, sha256: '', line_count: lineCount, content: seedText },
      file: FILE,
    });
    contentAfter.push(content);
    globalIdx++;
  }

  const editCount = randInt(rng, 20, 80);
  for (let k = 0; k < editCount; k++) {
    // Choose an in-range [startOff, endOff] in offset space.
    const a = randInt(rng, 0, content.length + 1);
    const b = randInt(rng, 0, content.length + 1);
    const startOff = Math.min(a, b);
    const endOff = Math.max(a, b);
    let startPos = toPos(content, startOff);
    let endPos = toPos(content, endOff);

    // 25% chance to push each endpoint out of range — both offsetOld and
    // offsetAt must clamp these identically. This exercises the clamp paths.
    if (rng() < 0.25) startPos.character += randInt(rng, 1, 5);
    if (rng() < 0.15) startPos.line += 1;
    if (rng() < 0.25) endPos.character += randInt(rng, 1, 5);
    if (rng() < 0.15) endPos.line += 1;

    // Resolve offsets with the OLD split-based algorithm (the oracle). If the
    // out-of-range overflow above happened to invert the range (clamped
    // start > clamped end), fall back to the clean in-range positions: VS Code
    // never emits an inverted Range, so feeding one is not a faithful input —
    // and on such input the OLD code was equally undefined, so it isn't a
    // semantics-preservation target.
    let sOff = offsetOld(content, startPos.line, startPos.character);
    let eOff = offsetOld(content, endPos.line, endPos.character);
    if (sOff > eOff) {
      startPos = toPos(content, startOff);
      endPos = toPos(content, endOff);
      sOff = startOff;
      eOff = endOff;
    }

    const text = randText(rng);
    const asPaste = rng() < 0.15;

    // Oracle: splice with the untouched pure helper (the pre-refactor algorithm).
    const next = spliceWithProvenance(content, prov, sOff, eOff, text, globalIdx);
    content = next.content;
    prov = next.provenance;

    if (asPaste) {
      events.push({
        sessionId: 's',
        seq: globalIdx,
        globalIdx,
        wall: '',
        t: globalIdx,
        kind: 'paste',
        payload: {
          path: FILE,
          range: { start: startPos, end: endPos },
          length: text.length,
          sha256: 'inline',
          content: text,
        },
        file: FILE,
      });
    } else {
      events.push({
        sessionId: 's',
        seq: globalIdx,
        globalIdx,
        wall: '',
        t: globalIdx,
        kind: 'doc.change',
        payload: {
          path: FILE,
          deltas: [{ range: { start: startPos, end: endPos }, text }],
          source: 'typed',
        },
        file: FILE,
      });
    }
    contentAfter.push(content);
    globalIdx++;
  }

  return { events, contentAfter, finalProvenance: prov, finalContent: content };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconstruct line-index refactor — differential fuzz vs split() oracle', () => {
  const STREAM_COUNT = 1000;
  const BASE_SEED = 0x9e3779b9;

  it('reconstructFileWithProvenance matches the old algorithm on content + provenance', () => {
    for (let i = 0; i < STREAM_COUNT; i++) {
      const stream = generateStream(BASE_SEED + i);
      const index = makeIndex(stream.events);

      const state = reconstructFileWithProvenance(index, FILE);

      expect(state.content, `stream ${i}: content`).toBe(stream.finalContent);
      // Invariant the production code documents: content.length === provenance.length.
      expect(state.provenance.length, `stream ${i}: prov length`).toBe(state.content.length);
      expect(Array.from(state.provenance), `stream ${i}: provenance`).toEqual(
        stream.finalProvenance,
      );
    }
  });

  it('reconstructFile (v1) matches the old algorithm on content', () => {
    for (let i = 0; i < STREAM_COUNT; i++) {
      const stream = generateStream(BASE_SEED + i);
      const index = makeIndex(stream.events);

      const result = reconstructFile(index, FILE);
      expect(result.content, `stream ${i}: v1 content`).toBe(stream.finalContent);
    }
  });

  it('both reconstructors agree at every prefix cut (upToGlobalIdx)', () => {
    for (let i = 0; i < STREAM_COUNT; i++) {
      const stream = generateStream(BASE_SEED + i);
      const index = makeIndex(stream.events);
      const n = stream.events.length;

      // Sample a handful of cut points per stream (incl. the boundaries).
      const cutRng = makeRng(BASE_SEED + i + 0x55555);
      const cuts = new Set<number>([0, n, randInt(cutRng, 0, n + 1), randInt(cutRng, 0, n + 1)]);

      for (const cut of cuts) {
        // upToGlobalIdx is exclusive: events [0, cut) are applied.
        const expected = cut === 0 ? '' : stream.contentAfter[cut - 1]!;

        const v1 = reconstructFile(index, FILE, cut);
        const v2 = reconstructFileWithProvenance(index, FILE, cut);

        expect(v1.content, `stream ${i}: v1 prefix @${cut}`).toBe(expected);
        expect(v2.content, `stream ${i}: v2 prefix @${cut}`).toBe(expected);
        expect(v2.provenance.length, `stream ${i}: v2 prefix @${cut} prov length`).toBe(
          v2.content.length,
        );
      }
    }
  });
});
