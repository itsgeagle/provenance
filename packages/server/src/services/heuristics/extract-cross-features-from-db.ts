/**
 * extractCrossFeaturesFromDb — memory-bounded cross-feature extraction.
 *
 * The cross-heuristic service (run-cross.ts) used to call reconstructBundleFromDb
 * for every submission in a semester and hold all the full Bundles + EventIndices
 * in memory at once. With ~50k events per submission × hundreds of submissions,
 * that working set reached multiple GB and OOM'd the worker (which, under
 * `--mode=all`, takes the API down with it).
 *
 * The cross-heuristics only need a tiny per-submission slice (see
 * `@provenance/analyzer .../cross/features.ts`): the paste events and a bounded
 * n-gram "fingerprint" of the event-kind stream. This module streams one
 * submission's events from the DB, computes that compact CrossSubmissionFeatures,
 * and lets the heavy event stream be GC'd before moving to the next submission —
 * so peak memory is one submission's events, not the whole semester's.
 *
 * ## globalIdx fidelity
 *
 * cross_flag_participants.supporting_seqs stores `globalIdx` values (the same
 * chronological index the analyzer/replay use). buildIndex assigns globalIdx as
 * the position after sorting events by (wall, sessionId, seq) — NOT the raw seq.
 * We replicate that exact sort here so the emitted supporting events translate to
 * identical globalIdx values, and we return a small seqKey→globalIdx map covering
 * only the events a cross-flag can reference (pastes + the leading representatives).
 */

import { eq, and } from 'drizzle-orm';
import {
  buildKindNgramSet,
  NGRAM_SIZE,
  REPRESENTATIVE_EVENT_COUNT,
} from '@provenance/analysis-core/heuristics/cross/features.js';
import type {
  CrossSubmissionFeatures,
  CrossPasteFeature,
} from '@provenance/analysis-core/heuristics/cross/types.js';
import { events } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

export type ExtractedCrossFeatures = {
  features: CrossSubmissionFeatures;
  /**
   * Map from `${sessionId}:${seq}` to globalIdx, for exactly the events a
   * cross-flag may reference (all paste events + the leading representative
   * events). Used by run-cross.ts to translate eventsPerBundle seqKeys back to
   * supporting_seqs without holding a full EventIndex.
   */
  globalIdxBySeqKey: Map<string, number>;
};

function isoWall(wall: unknown): string {
  return wall instanceof Date ? wall.toISOString() : String(wall);
}

/**
 * Stream a submission's events from the DB and reduce them to the compact
 * cross-heuristic feature set (no full Bundle / EventIndex materialized).
 *
 * @param db           - Drizzle DB handle.
 * @param submissionId - UUID of the submission to extract.
 * @param bundleId     - Synthetic bundle id to tag the features with (caller keeps
 *                       the bundleId→submissionId mapping, mirroring the prior
 *                       reconstructBundleFromDb behaviour).
 */
export async function extractCrossFeaturesFromDb(
  db: DrizzleDb,
  submissionId: string,
  bundleId: string,
): Promise<ExtractedCrossFeatures> {
  // ---------------------------------------------------------------------------
  // Step 1: the event-kind stream (no payloads — this is the firehose).
  // ---------------------------------------------------------------------------
  const rows = await db
    .select({
      session_id: events.session_id,
      seq: events.seq,
      wall: events.wall,
      kind: events.kind,
    })
    .from(events)
    .where(eq(events.submission_id, submissionId));

  // Replicate buildIndex's chronological order: (wall, sessionId, seq).
  const ordered = rows
    .map((r) => ({ ...r, wallIso: isoWall(r.wall) }))
    .sort((a, b) => {
      if (a.wallIso < b.wallIso) return -1;
      if (a.wallIso > b.wallIso) return 1;
      if (a.session_id < b.session_id) return -1;
      if (a.session_id > b.session_id) return 1;
      return a.seq - b.seq;
    });

  const kinds: string[] = new Array(ordered.length);
  const representativeSeqKeys: string[] = [];
  const globalIdxBySeqKey = new Map<string, number>();

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]!;
    kinds[i] = r.kind;
    const seqKey = `${r.session_id}:${r.seq}`;
    if (i < REPRESENTATIVE_EVENT_COUNT) representativeSeqKeys.push(seqKey);
    // Only the events a cross-flag can reference need a globalIdx mapping:
    // the leading representatives (editing_pattern_clone) and pastes (paste_shared).
    if (r.kind === 'paste' || i < REPRESENTATIVE_EVENT_COUNT) {
      globalIdxBySeqKey.set(seqKey, i);
    }
  }

  const kindNgrams = buildKindNgramSet(kinds, NGRAM_SIZE);

  // ---------------------------------------------------------------------------
  // Step 2: paste payloads (typically a handful per submission).
  // ---------------------------------------------------------------------------
  const pasteRows = await db
    .select({
      session_id: events.session_id,
      seq: events.seq,
      payload: events.payload,
    })
    .from(events)
    .where(and(eq(events.submission_id, submissionId), eq(events.kind, 'paste')));

  const pastes: CrossPasteFeature[] = pasteRows.map((pr) => {
    const p =
      typeof pr.payload === 'object' && pr.payload !== null
        ? (pr.payload as Record<string, unknown>)
        : null;
    return {
      seqKey: `${pr.session_id}:${pr.seq}`,
      sha256: p !== null && typeof p['sha256'] === 'string' ? (p['sha256'] as string) : undefined,
      content:
        p !== null && typeof p['content'] === 'string' ? (p['content'] as string) : undefined,
      length: p !== null && typeof p['length'] === 'number' ? (p['length'] as number) : 0,
    };
  });

  const features: CrossSubmissionFeatures = {
    bundleId,
    sourceFilename: `reconstruct-stub-${submissionId}`,
    pastes,
    kindNgrams,
    eventCount: ordered.length,
    representativeSeqKeys,
  };

  return { features, globalIdxBySeqKey };
}
