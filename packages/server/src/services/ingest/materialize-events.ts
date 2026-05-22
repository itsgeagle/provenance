/**
 * Phase 6 of the per-file ingest pipeline: materialize events into the DB
 * (PRD §9.3, §5.4).
 *
 * Inserts all events from a parsed Bundle into the events table in
 * chronological order (globalIdx from v2 buildIndex). Uses chunked multi-row
 * INSERTs to stay well under Postgres's 65535-parameter limit:
 *   EVENTS_INSERT_CHUNK_SIZE (1000) rows × 9 columns = 9000 params per batch.
 *
 * Idempotent via ON CONFLICT DO NOTHING on the (submission_id, seq) PK.
 * Safe to call on pg-boss retry — PK collision silently deduplicates.
 *
 * Transaction: callers wrap this in a transaction for atomicity with the
 * ingest_files status update. This function does NOT open its own transaction.
 */

import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import type { Bundle } from '@provenance/analyzer/src/loader/types.js';
import { events } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

export const EVENTS_INSERT_CHUNK_SIZE = 1000;

export async function materializeEvents(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
): Promise<void> {
  const index = buildIndex(bundle);
  if (index.ordered.length === 0) return;

  type HashedEnvelope = (typeof bundle.sessions)[number]['events'][number];
  const envelopeMap = new Map<string, HashedEnvelope>();
  for (const session of bundle.sessions) {
    for (const envelope of session.events) {
      envelopeMap.set(`${session.sessionId}:${envelope.seq}`, envelope);
    }
  }

  type EventRow = typeof events.$inferInsert;
  const rows: EventRow[] = [];

  for (const ie of index.ordered) {
    const key = `${ie.sessionId}:${ie.seq}`;
    const envelope = envelopeMap.get(key);
    if (envelope === undefined) {
      throw new Error(
        `materializeEvents: envelope not found for key=${key} (submissionId=${submissionId})`,
      );
    }
    rows.push({
      submission_id: submissionId,
      seq: ie.globalIdx,
      session_id: ie.sessionId,
      t: ie.t,
      wall: new Date(ie.wall),
      kind: ie.kind,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: jsonb accepts JSON-serializable value
      payload: envelope.data as any,
      prev_hash: envelope.prev_hash,
      hash: envelope.hash,
    });
  }

  for (let i = 0; i < rows.length; i += EVENTS_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + EVENTS_INSERT_CHUNK_SIZE);
    await db.insert(events).values(chunk).onConflictDoNothing();
  }
}
