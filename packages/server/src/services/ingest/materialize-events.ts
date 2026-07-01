/**
 * Phase 6 of the per-file ingest pipeline: materialize events into the DB
 * (PRD §9.3, §5.4).
 *
 * Inserts all events from a parsed Bundle into the events table in
 * chronological order (globalIdx from v2 buildIndex).
 *
 * ## Bulk-load strategy
 *
 * A single set-based INSERT that expands the whole bundle from ONE json
 * parameter via `json_to_recordset(...)`. This pays ONE SQL parse + ONE bind +
 * ONE executor pass for the entire submission, instead of the former chunked
 * multi-row INSERT (≈9000 bind params × dozens of round-trips, each re-planned
 * and per-value marshaled). The physical cost that remains — heap inserts +
 * maintaining the four indexes — is the irreducible floor and is identical for
 * any insert shape.
 *
 * Why json (single string param) rather than array params: drizzle's `sql`
 * template EXPANDS an interpolated JS array into a comma-separated placeholder
 * list (`$1, $2, …`), which both breaks `::type[]` casts and blows Postgres's
 * 65535-param ceiling on large bundles. A single JSON string binds as one param
 * and is expanded server-side. `JSON.stringify` also handles all escaping of
 * embedded quotes / backslashes / newlines / unicode in the payload, which is
 * safer than hand-rolled COPY-text or array-literal escaping. The `submission_id`
 * is a separate scalar param (constant per call) so it stays out of the blob.
 * `wall` rides as an ISO-8601 string and is cast `::timestamptz` server-side;
 * `payload` rides as a nested json value and is cast `::jsonb`.
 *
 * Idempotent via ON CONFLICT DO NOTHING on the (submission_id, seq) PK.
 * Safe to call on pg-boss retry — PK collision silently deduplicates. globalIdx
 * is unique per submission by construction, so there are no intra-batch PK
 * collisions (which ON CONFLICT cannot dedupe).
 *
 * Transaction: callers wrap this in a transaction for atomicity with the
 * ingest_files status update. This function does NOT open its own transaction.
 */

import { sql } from 'drizzle-orm';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { DrizzleDb } from '../../db/client.js';

/**
 * @param index - optional prebuilt EventIndex. The ingest worker builds the
 *   index once per submission and shares it across phases; pass it here to skip
 *   a redundant rebuild. Falls back to buildIndex(bundle) when omitted.
 */
export async function materializeEvents(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
  index: EventIndex = buildIndex(bundle),
): Promise<void> {
  if (index.ordered.length === 0) return;

  type HashedEnvelope = (typeof bundle.sessions)[number]['events'][number];
  const envelopeMap = new Map<string, HashedEnvelope>();
  for (const session of bundle.sessions) {
    for (const envelope of session.events) {
      envelopeMap.set(`${session.sessionId}:${envelope.seq}`, envelope);
    }
  }

  const rows = new Array<{
    seq: number;
    session_id: string;
    t: number;
    wall: string;
    kind: string;
    payload: unknown;
    prev_hash: string;
    hash: string;
  }>(index.ordered.length);

  for (let i = 0; i < index.ordered.length; i++) {
    const ie = index.ordered[i]!;
    const key = `${ie.sessionId}:${ie.seq}`;
    const envelope = envelopeMap.get(key);
    if (envelope === undefined) {
      throw new Error(
        `materializeEvents: envelope not found for key=${key} (submissionId=${submissionId})`,
      );
    }
    rows[i] = {
      seq: ie.globalIdx,
      session_id: ie.sessionId,
      t: ie.t,
      wall: new Date(ie.wall).toISOString(),
      kind: ie.kind,
      payload: envelope.data,
      prev_hash: envelope.prev_hash,
      hash: envelope.hash,
    };
  }

  const json = JSON.stringify(rows);

  await db.execute(sql`
    INSERT INTO events
      (submission_id, seq, session_id, t, wall, kind, payload, prev_hash, hash)
    SELECT ${submissionId}::uuid, x.seq, x.session_id, x.t, x.wall, x.kind,
           x.payload::jsonb, x.prev_hash, x.hash
    FROM json_to_recordset(${json}::json) AS x(
      seq int, session_id text, t int, wall timestamptz, kind text,
      payload json, prev_hash text, hash text
    )
    ON CONFLICT (submission_id, seq) DO NOTHING
  `);
}
