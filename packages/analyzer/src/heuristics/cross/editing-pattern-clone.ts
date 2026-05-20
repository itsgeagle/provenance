/**
 * editing_pattern_clone cross-heuristic (Phase 18).
 *
 * PRD §7.4 cross-submission heuristics.
 *
 * Measures the similarity of editing behaviour between pairs of bundles using
 * Jaccard similarity over 3-grams of the event-kind stream. When the similarity
 * of a pair exceeds the threshold (default 0.3), a CrossFlag is emitted.
 *
 * Algorithm (A61 — Jaccard 3-gram, pair-wise):
 *   1. For each bundle, build a "kind stream": the ordered sequence of event
 *      kinds (e.g. ["session.start", "doc.change", "paste", "doc.save", ...]).
 *      All events from all sessions are concatenated in chronological order.
 *   2. Compute the multiset of 3-grams of the kind stream. Each 3-gram is a
 *      `"${k0}|${k1}|${k2}"` string. Use Set (not multiset) for Jaccard
 *      computation — distinct 3-gram types, not counts.
 *   3. Jaccard(A, B) = |A ∩ B| / |A ∪ B|.
 *   4. For every pair of bundles (O(N²), fine for N ≤ 10), if Jaccard ≥ threshold,
 *      emit one CrossFlag.
 *
 * Why Jaccard over kind-stream 3-grams?
 *   - The kind stream is insensitive to content (no privacy concerns).
 *   - 3-grams capture local editing rhythm without requiring global alignment.
 *   - Jaccard over a type-set (not multiset) avoids rewarding repetition
 *     (e.g., 10,000 doc.change events generate the same 3-gram set as 100).
 *   - Fast: O(N_events) per bundle + O(G²) for set intersection.
 *
 * Severity: medium (confidence 0.7). Jaccard over kind-streams is a
 * coarse signal; it fires on structurally similar workflows which is
 * indicative but not conclusive.
 *
 * Supporting events: all events from both bundles are too many to list.
 * We pick the first 5 events from each bundle as representative references.
 * Course staff reviews the full bundles via /compare split-pane.
 */

import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';
import type { CrossFlag, CrossHeuristic, CrossHeuristicConfig } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of 3-gram strings from the kind stream of a bundle's events.
 * All sessions' events are concatenated in chronological (globalIdx) order.
 */
function buildKindNgramSet(index: EventIndex, n: number): Set<string> {
  const kinds = index.ordered.map((e) => e.kind);
  const ngramSet = new Set<string>();
  for (let i = 0; i <= kinds.length - n; i++) {
    const ngram = kinds.slice(i, i + n).join('|');
    ngramSet.add(ngram);
  }
  return ngramSet;
}

/**
 * Jaccard similarity between two sets.
 * Returns 0 when both sets are empty to avoid 0/0.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Cross-heuristic implementation
// ---------------------------------------------------------------------------

const NGRAM_SIZE = 3;
const REPRESENTATIVE_EVENT_COUNT = 5;

function run(
  bundles: Bundle[],
  indices: Map<string, EventIndex>,
  config: CrossHeuristicConfig,
): CrossFlag[] {
  const { editingPatternCloneThreshold: threshold } = config;

  if (bundles.length < 2) return [];

  // Build per-bundle kind-ngram sets.
  type BundleNgrams = { bundle: Bundle; ngramSet: Set<string>; index: EventIndex };
  const bundleNgrams: BundleNgrams[] = [];

  for (const bundle of bundles) {
    const index = indices.get(bundle.id);
    if (index === undefined) continue;
    if (index.ordered.length < NGRAM_SIZE) continue; // too few events to form any 3-gram

    const ngramSet = buildKindNgramSet(index, NGRAM_SIZE);
    bundleNgrams.push({ bundle, ngramSet, index });
  }

  if (bundleNgrams.length < 2) return [];

  const flags: CrossFlag[] = [];
  let flagIndex = 0;

  // Pair-wise Jaccard comparison — O(N²) over bundles, fine for N ≤ 10.
  for (let i = 0; i < bundleNgrams.length; i++) {
    for (let j = i + 1; j < bundleNgrams.length; j++) {
      const aEntry = bundleNgrams[i]!;
      const bEntry = bundleNgrams[j]!;

      const score = jaccard(aEntry.ngramSet, bEntry.ngramSet);
      if (score < threshold) continue;

      const bundleIds = [aEntry.bundle.id, bEntry.bundle.id].sort();

      // Pick representative supporting events: first N from each bundle.
      const aEvents = aEntry.index.ordered.slice(0, REPRESENTATIVE_EVENT_COUNT);
      const bEvents = bEntry.index.ordered.slice(0, REPRESENTATIVE_EVENT_COUNT);

      const eventsPerBundle: Record<string, string[]> = {
        [aEntry.bundle.id]: aEvents.map((e) => `${e.sessionId}:${e.seq}`),
        [bEntry.bundle.id]: bEvents.map((e) => `${e.sessionId}:${e.seq}`),
      };

      const id = `editing_pattern_clone-${bundleIds.join('|')}-${flagIndex++}`;

      flags.push({
        id,
        heuristic: 'editing_pattern_clone',
        title: `Editing-pattern clone detected (Jaccard ${(score * 100).toFixed(0)}%)`,
        severity: 'medium',
        confidence: 0.7,
        bundleIds,
        eventsPerBundle,
        description:
          `The editing event-kind streams of ${aEntry.bundle.sourceFilename} and ` +
          `${bEntry.bundle.sourceFilename} share ${(score * 100).toFixed(0)}% of their ` +
          `${NGRAM_SIZE}-gram vocabulary (Jaccard similarity = ${score.toFixed(3)}, ` +
          `threshold = ${threshold}). Structurally similar workflows may indicate ` +
          `collaboration or shared external tooling.`,
        detail: {
          jaccardScore: score,
          ngramSize: NGRAM_SIZE,
          threshold,
          aNgramCount: aEntry.ngramSet.size,
          bNgramCount: bEntry.ngramSet.size,
          bundleA: aEntry.bundle.sourceFilename,
          bundleB: bEntry.bundle.sourceFilename,
        },
      });
    }
  }

  return flags;
}

export const editingPatternCloneHeuristic: CrossHeuristic = {
  id: 'editing_pattern_clone',
  label: 'Editing-pattern clone',
  run,
};
