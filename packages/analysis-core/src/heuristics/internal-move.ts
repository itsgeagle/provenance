/**
 * internal_move classification.
 *
 * A paste is an "internal move" when its content matches a region of the
 * student's own prior content whose provenance is *typed* (or preexisting
 * starter code). Those pastes are the student reorganising their own work —
 * copying a block, cutting and re-pasting it, moving a helper into another file.
 * Firing large_paste / paste_is_solution at full severity on them trains graders
 * to dismiss the whole flag class, which costs the true positives too.
 *
 * The provenance requirement is what stops this being a laundering path. Without
 * it, a student could paste an external solution into scratch.py, then cut it and
 * paste it into hw3.py, and the second paste would look internal.
 *
 * Everything here is fail-closed. Any uncertainty — tainted reconstruction, a
 * paste with no inline content, a candidate below the size gate, a match whose
 * source region is not predominantly the student's own — leaves the candidate
 * unclassified, and callers treat unclassified as a full-severity external paste.
 *
 * Determinism: no wall clock, no randomness, no iteration over unordered
 * structures whose order could vary. Ingest retries must produce identical flags.
 */

import type { EventIndex } from '../index/event-index.js';
import type { FileReplayState, ProvenanceKind } from '../index/reconstruct-file-provenance.js';
import { reconstructFileWithProvenance } from '../index/reconstruct-file-provenance.js';
import type { HeuristicConfig } from './config.js';
import type { CandidatePaste } from './candidate-pastes.js';
import { iterateCandidatePastes } from './candidate-pastes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MoveVia = 'copy' | 'cut';
export type MoveClassification = 'internal_move' | 'external' | 'unknown';

export type MoveResult = {
  classification: MoveClassification;
  /** File the matched source region lives (or lived) in. */
  sourcePath?: string;
  /** globalIdx of the snapshot point the match was found at. */
  sourceGlobalIdx?: number;
  /** Fraction of the paste's non-blank lines that matched. */
  matchRatio?: number;
  /** Fraction of the matched source region attributable to the student. */
  typedRatio?: number;
  via?: MoveVia;
};

/** Provenance kinds that count as "the student's own work". */
const OWN_KINDS: ReadonlySet<ProvenanceKind> = new Set<ProvenanceKind>(['typed', 'preexisting']);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise text for structural comparison: normalise line endings, strip
 * per-line indentation, drop blank lines.
 *
 * Stripping indentation is what lets a block survive being moved into a nested
 * scope, or being auto-indented by the editor as it lands. Exported for tests.
 */
export function normalizeForMatch(text: string): string {
  return splitNormalizedLines(text).join('\n');
}

/** The non-blank, trimmed lines of `text`, in order. */
function splitNormalizedLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * The non-blank lines of `content`, each with its flat offsets in the ORIGINAL
 * string. Matching happens on `text`; the offsets are what the provenance check
 * needs, which is why this is a parallel index rather than a normalised copy.
 */
type LineEntry = { text: string; start: number; end: number };

function indexNonBlankLines(content: string): LineEntry[] {
  const out: LineEntry[] = [];
  let offset = 0;
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const lead = raw.length - raw.trimStart().length;
      out.push({
        text: trimmed,
        start: offset + lead,
        end: offset + lead + trimmed.length,
      });
    }
    offset += raw.length + 1; // +1 for the '\n' that split consumed
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line-run matching
// ---------------------------------------------------------------------------

type LineRun = { startLine: number; endLine: number; matchRatio: number };

/**
 * Find a contiguous run of `haystack` lines matching `needle` from its first
 * line, accepting when the run covers at least `minMatchRatio` of the needle.
 *
 * Deliberately near-exact rather than fuzzy. A fuzzy threshold here would be a
 * hole rather than a convenience: "vaguely similar to something I once wrote" is
 * satisfiable by a great deal of code, and this predicate is what decides
 * whether a flag survives.
 *
 * Returns the longest qualifying run, or null.
 */
function findLineRun(
  haystack: LineEntry[],
  needle: string[],
  minMatchRatio: number,
): LineRun | null {
  if (needle.length === 0 || haystack.length === 0) return null;
  const required = Math.ceil(needle.length * minMatchRatio);
  if (required === 0) return null;

  let best: LineRun | null = null;
  const first = needle[0]!;
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i]!.text !== first) continue;
    let run = 0;
    while (run < needle.length && i + run < haystack.length) {
      if (haystack[i + run]!.text !== needle[run]!) break;
      run++;
    }
    if (run < required) continue;
    const ratio = run / needle.length;
    if (best === null || ratio > best.matchRatio) {
      best = { startLine: i, endLine: i + run, matchRatio: ratio };
    }
  }
  return best;
}

/**
 * Fraction of `[start, end)` in `state` attributable to the student's own work.
 * Returns 0 for an empty span, so an empty match can never qualify.
 */
function ownRatio(state: FileReplayState, start: number, end: number): number {
  if (end <= start) return 0;
  const limit = Math.min(end, state.provenance.length);
  if (limit <= start) return 0;
  let own = 0;
  for (let i = start; i < limit; i++) {
    const kind = state.kindByGlobalIdx.get(state.provenance[i]!);
    if (kind !== undefined && OWN_KINDS.has(kind)) own++;
  }
  return own / (end - start);
}

// ---------------------------------------------------------------------------
// Deletion sites
// ---------------------------------------------------------------------------

type DocRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type DeletionSite = { globalIdx: number; path: string; range: DocRange };

/**
 * Pre-filter deletion sites straight from event payloads, without needing any
 * content: a delta whose range spans at least one line boundary, or at least
 * `minBlobChars` characters on a single line. The exact byte length is measured
 * later against the snapshot, so this only has to be a superset.
 *
 * Known gap: a same-line deletion shorter than `minBlobChars` is skipped, which
 * is correct (it can never match a blob we would record). Everything else that
 * could plausibly carry a moved block is included.
 */
function collectDeletionSites(index: EventIndex, minBlobChars: number): DeletionSite[] {
  const sites: DeletionSite[] = [];
  for (const e of index.ordered) {
    if (e.kind !== 'doc.change' && e.kind !== 'paste') continue;
    const p = e.payload as Record<string, unknown> | null;
    if (p === null) continue;
    const path = typeof p['path'] === 'string' ? p['path'] : undefined;
    if (path === undefined) continue;

    const ranges: DocRange[] = [];
    if (e.kind === 'paste') {
      const r = p['range'];
      if (typeof r === 'object' && r !== null) ranges.push(r as DocRange);
    } else {
      const deltas = p['deltas'];
      if (!Array.isArray(deltas)) continue;
      for (const dRaw of deltas as unknown[]) {
        if (typeof dRaw !== 'object' || dRaw === null) continue;
        const d = dRaw as { range?: unknown };
        if (typeof d.range === 'object' && d.range !== null) ranges.push(d.range as DocRange);
      }
    }

    for (const range of ranges) {
      const lineSpan = range.end.line - range.start.line;
      const charSpan = range.end.character - range.start.character;
      if (lineSpan >= 1 || charSpan >= minBlobChars) {
        sites.push({ globalIdx: e.globalIdx, path, range });
      }
    }
  }
  return sites;
}

/** Flat offset of a (line, character) position, clamped to the line's end. */
function offsetOf(content: string, line: number, character: number): number {
  if (line < 0) return 0;
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) return content.length;
    offset = nl + 1;
  }
  const nl = content.indexOf('\n', offset);
  const lineEnd = nl === -1 ? content.length : nl;
  return Math.min(offset + character, lineEnd);
}

// ---------------------------------------------------------------------------
// Deletion ledger
// ---------------------------------------------------------------------------

type LedgerEntry = {
  globalIdx: number;
  path: string;
  lines: string[];
  /** True when the removed region was predominantly the student's own work. */
  own: boolean;
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify every candidate paste in `index`, keyed by `CandidatePaste.ordinal`.
 *
 * A candidate absent from the returned map was not established as an internal
 * move; callers must treat absence as `'external'` and leave the flag intact.
 */
export function classifyInternalMoves(
  index: EventIndex,
  config: HeuristicConfig,
): Map<number, MoveResult> {
  const results = new Map<number, MoveResult>();
  const cfg = config.internalMove;
  if (!cfg.enabled) return results;

  // Size gate. A paste with no inline content (over the recorder's inline cap)
  // cannot be compared at all, and one below minBlobChars could never match a
  // ledger blob, since blobs that small are never recorded.
  const candidates: CandidatePaste[] = [];
  for (const c of iterateCandidatePastes(index)) {
    if (c.content === undefined) continue;
    if (c.content.length < cfg.minBlobChars) continue;
    candidates.push(c);
  }
  if (candidates.length === 0) return results;

  const needleByOrdinal = new Map<number, string[]>();
  const candidatesByGlobalIdx = new Map<number, CandidatePaste[]>();
  for (const c of candidates) {
    needleByOrdinal.set(c.ordinal, splitNormalizedLines(c.content!));
    const arr = candidatesByGlobalIdx.get(c.globalIdx);
    if (arr === undefined) candidatesByGlobalIdx.set(c.globalIdx, [c]);
    else arr.push(c);
  }

  const deletionSites = collectDeletionSites(index, cfg.minBlobChars);
  const sitesByGlobalIdx = new Map<number, DeletionSite[]>();
  for (const s of deletionSites) {
    const arr = sitesByGlobalIdx.get(s.globalIdx);
    if (arr === undefined) sitesByGlobalIdx.set(s.globalIdx, [s]);
    else arr.push(s);
  }

  const snapshotAt = [
    ...new Set([...candidates.map((c) => c.globalIdx), ...deletionSites.map((s) => s.globalIdx)]),
  ].sort((a, b) => a - b);

  const ledger: LedgerEntry[] = [];
  let ledgerBytes = 0;

  function recordDeletion(
    globalIdx: number,
    path: string,
    state: FileReplayState,
    range: DocRange,
  ): void {
    const start = offsetOf(state.content, range.start.line, range.start.character);
    const end = offsetOf(state.content, range.end.line, range.end.character);
    if (end - start < cfg.minBlobChars) return;
    const text = state.content.slice(start, end);
    const lines = splitNormalizedLines(text);
    if (lines.length === 0) return;

    // Oldest-first eviction, deterministic and independent of wall clock.
    while (ledger.length > 0 && ledgerBytes + text.length > cfg.ledgerMaxBytes) {
      const evicted = ledger.shift()!;
      ledgerBytes -= evicted.lines.join('\n').length;
    }
    if (text.length > cfg.ledgerMaxBytes) return;

    ledger.push({
      globalIdx,
      path,
      lines,
      own: ownRatio(state, start, end) >= cfg.typedRatio,
    });
    ledgerBytes += text.length;
  }

  function tryLiveMatch(
    globalIdx: number,
    path: string,
    state: FileReplayState,
    pending: CandidatePaste[],
  ): void {
    // Only pay for the line index when a candidate actually lands here; most
    // snapshot points are deletion sites, which don't need it.
    const haystack = indexNonBlankLines(state.content);
    if (haystack.length === 0) return;

    for (const c of pending) {
      if (results.get(c.ordinal)?.classification === 'internal_move') continue;
      const needle = needleByOrdinal.get(c.ordinal);
      if (needle === undefined || needle.length === 0) continue;

      const run = findLineRun(haystack, needle, cfg.minMatchRatio);
      if (run === null) continue;

      const spanStart = haystack[run.startLine]!.start;
      const spanEnd = haystack[run.endLine - 1]!.end;
      const typed = ownRatio(state, spanStart, spanEnd);
      if (typed < cfg.typedRatio) continue;

      results.set(c.ordinal, {
        classification: 'internal_move',
        sourcePath: path,
        sourceGlobalIdx: globalIdx,
        matchRatio: run.matchRatio,
        typedRatio: typed,
        via: 'copy',
      });
    }
  }

  // --- Phase 1: one replay pass per file. ---------------------------------
  // Snapshots fire at every point, for every file, so a candidate in hw.py is
  // matched against what utils.py looked like at that instant too.
  for (const path of index.byFile.keys()) {
    reconstructFileWithProvenance(index, path, undefined, {
      snapshotAt,
      onSnapshot: (globalIdx, state) => {
        if (state.content.length === 0) {
          // Nothing to match against and nothing to delete from.
          return;
        }
        const pending = candidatesByGlobalIdx.get(globalIdx);
        if (pending !== undefined) tryLiveMatch(globalIdx, path, state, pending);

        for (const site of sitesByGlobalIdx.get(globalIdx) ?? []) {
          if (site.path !== path) continue;
          recordDeletion(globalIdx, path, state, site.range);
        }
      },
    });
  }

  // --- Phase 2: ledger match. ---------------------------------------------
  // Deferred until every file's pass has run, so a cross-file cut-and-paste
  // resolves without needing a second replay. Ledger entries carry their own
  // text and provenance verdict, so no replay state is needed here.
  for (const c of candidates) {
    if (results.get(c.ordinal)?.classification === 'internal_move') continue;
    const needle = needleByOrdinal.get(c.ordinal);
    if (needle === undefined || needle.length === 0) continue;

    for (const entry of ledger) {
      if (entry.globalIdx >= c.globalIdx) continue;
      if (!entry.own) continue;
      const hay: LineEntry[] = entry.lines.map((text) => ({ text, start: 0, end: 0 }));
      const run = findLineRun(hay, needle, cfg.minMatchRatio);
      if (run === null) continue;

      results.set(c.ordinal, {
        classification: 'internal_move',
        sourcePath: entry.path,
        sourceGlobalIdx: entry.globalIdx,
        matchRatio: run.matchRatio,
        // The ledger entry already passed the provenance gate when recorded.
        typedRatio: 1,
        via: 'cut',
      });
      break;
    }
  }

  return results;
}
