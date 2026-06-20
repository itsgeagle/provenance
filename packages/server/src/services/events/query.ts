/**
 * Events query builder — PRD §8.9.
 *
 * Translates query params → SQL for GET /submissions/{id}/events.
 *
 * Index hints (trust Postgres, no EXPLAIN tests per V35):
 *   - kind + t_from/t_to  → events_sub_kind_t_idx (submission_id, kind, t)
 *   - t_from/t_to only    → events_sub_t_idx (submission_id, t)
 *   - session_id          → PK (submission_id, seq) scan with a residual
 *       session_id filter. The dedicated (submission_id, session_id, seq) index
 *       was dropped (migration 0017) to cut ingest index-maintenance cost; the
 *       PK already yields seq order, so this only over-reads other sessions —
 *       cheap for the typical 1–3-session submission.
 *   - seq_from/seq_to     → PK (submission_id, seq)
 *   - file (payload->>'path')  → NO covering index; documented cost below
 *
 * file filter cost note:
 *   `payload->>'path' = $file` does a full scan of events for the submission.
 *   This is acceptable at current scale (~10k events/submission) since the scan
 *   is bounded by submission_id (PK prefix). A future GIN index on payload could
 *   accelerate this if file-filtered queries become the dominant access pattern.
 *
 * total_count:
 *   Only included when at least one of `kind` / `file` / `session_id` is in the
 *   query. Without these filters, counting is O(N) with no offsetting gain, so
 *   we omit it (cheap rule per PRD §8.9 line 1183).
 *
 * Cursor format:
 *   base64 JSON { seq: int }. Decode → seq > cursor.seq (asc) or seq < cursor.seq (desc).
 *   The seq field in the cursor uses the global seq (events.seq), not session-local seq.
 */

import { and, eq, gt, lt, gte, lte, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { events } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventQueryParams = {
  /** Repeated; OR semantics if multiple */
  kind?: string[];
  seq_from?: number;
  seq_to?: number;
  t_from?: number;
  t_to?: number;
  wall_from?: string; // ISO date string
  wall_to?: string; // ISO date string
  file?: string; // payload->>'path'
  session_id?: string;
  order?: 'seq_asc' | 'seq_desc';
  cursor?: string; // base64 JSON { seq: int }
  limit?: number;
};

export type EventRow = {
  submission_id: string;
  seq: number;
  session_id: string;
  t: number;
  wall: string; // ISO date string
  kind: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
};

export type EventQueryResult = {
  items: EventRow[];
  next_cursor: string | null;
  total_count?: number;
};

// ---------------------------------------------------------------------------
// Cursor encode/decode
// ---------------------------------------------------------------------------

export function encodeEventCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq })).toString('base64');
}

export function decodeEventCursor(cursor: string): { seq: number } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'seq' in parsed &&
      typeof (parsed as { seq: unknown }).seq === 'number'
    ) {
      return { seq: (parsed as { seq: number }).seq };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

export async function queryEvents(
  db: DrizzleDb,
  submissionId: string,
  params: EventQueryParams,
): Promise<EventQueryResult> {
  const order = params.order ?? 'seq_asc';
  const limit = params.limit ?? DEFAULT_LIMIT;

  // Validate limit
  if (limit > MAX_LIMIT) {
    throw Errors.eventQueryLimitExceeded(MAX_LIMIT);
  }

  // Validate ranges
  if (
    params.seq_from !== undefined &&
    params.seq_to !== undefined &&
    params.seq_from > params.seq_to
  ) {
    throw Errors.eventQueryRangeInvalid('seq_from must be <= seq_to');
  }
  if (params.t_from !== undefined && params.t_to !== undefined && params.t_from > params.t_to) {
    throw Errors.eventQueryRangeInvalid('t_from must be <= t_to');
  }
  if (params.wall_from !== undefined) {
    const fromMs = new Date(params.wall_from).getTime();
    if (isNaN(fromMs)) {
      throw Errors.eventQueryRangeInvalid('wall_from must be a valid ISO date');
    }
  }
  if (params.wall_to !== undefined) {
    const toMs = new Date(params.wall_to).getTime();
    if (isNaN(toMs)) {
      throw Errors.eventQueryRangeInvalid('wall_to must be a valid ISO date');
    }
  }
  if (params.wall_from !== undefined && params.wall_to !== undefined) {
    const fromMs = new Date(params.wall_from).getTime();
    const toMs = new Date(params.wall_to).getTime();
    if (fromMs > toMs) {
      throw Errors.eventQueryRangeInvalid('wall_from must be <= wall_to');
    }
  }
  if (params.seq_from !== undefined && params.seq_from < 0) {
    throw Errors.eventQueryRangeInvalid('seq_from must be >= 0');
  }
  if (params.seq_to !== undefined && params.seq_to < 0) {
    throw Errors.eventQueryRangeInvalid('seq_to must be >= 0');
  }
  if (params.t_from !== undefined && params.t_from < 0) {
    throw Errors.eventQueryRangeInvalid('t_from must be >= 0');
  }
  if (params.t_to !== undefined && params.t_to < 0) {
    throw Errors.eventQueryRangeInvalid('t_to must be >= 0');
  }

  // Build WHERE predicates
  const predicates: SQL[] = [eq(events.submission_id, submissionId)];

  if (params.kind && params.kind.length > 0) {
    if (params.kind.length === 1) {
      predicates.push(eq(events.kind, params.kind[0]!));
    } else {
      predicates.push(inArray(events.kind, params.kind));
    }
  }

  if (params.seq_from !== undefined) {
    predicates.push(gte(events.seq, params.seq_from));
  }
  if (params.seq_to !== undefined) {
    predicates.push(lte(events.seq, params.seq_to));
  }

  if (params.t_from !== undefined) {
    predicates.push(gte(events.t, params.t_from));
  }
  if (params.t_to !== undefined) {
    predicates.push(lte(events.t, params.t_to));
  }

  if (params.wall_from !== undefined) {
    predicates.push(gte(events.wall, new Date(params.wall_from)));
  }
  if (params.wall_to !== undefined) {
    predicates.push(lte(events.wall, new Date(params.wall_to)));
  }

  if (params.file !== undefined) {
    // No covering index for payload->>'path'; bounded by submission_id PK prefix.
    predicates.push(sql`${events.payload}->>'path' = ${params.file}`);
  }

  if (params.session_id !== undefined) {
    predicates.push(eq(events.session_id, params.session_id));
  }

  // Cursor predicate
  if (params.cursor !== undefined) {
    const decoded = decodeEventCursor(params.cursor);
    if (decoded !== null) {
      if (order === 'seq_asc') {
        predicates.push(gt(events.seq, decoded.seq));
      } else {
        predicates.push(lt(events.seq, decoded.seq));
      }
    }
    // Invalid cursor: silently ignore (treat as no cursor) — lenient for clients
  }

  const where = and(...predicates);

  // Determine if we should compute total_count (opt-in per PRD §8.9)
  const shouldCountTotal =
    (params.kind !== undefined && params.kind.length > 0) ||
    params.file !== undefined ||
    params.session_id !== undefined;

  // Execute main query + optional count in parallel
  const [rows, countResult] = await Promise.all([
    db
      .select({
        submission_id: events.submission_id,
        seq: events.seq,
        session_id: events.session_id,
        t: events.t,
        wall: events.wall,
        kind: events.kind,
        payload: events.payload,
        prev_hash: events.prev_hash,
        hash: events.hash,
      })
      .from(events)
      .where(where)
      .orderBy(order === 'seq_asc' ? events.seq : sql`${events.seq} DESC`)
      .limit(limit + 1), // fetch one extra to detect next page
    shouldCountTotal
      ? db
          .select({ count: sql<number>`count(*)::int` })
          .from(events)
          .where(where)
      : Promise.resolve(null),
  ]);

  // Determine if there's a next page
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Build next_cursor from last item in page
  let next_cursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1]!;
    next_cursor = encodeEventCursor(lastRow.seq);
  }

  const items: EventRow[] = pageRows.map((r) => ({
    submission_id: r.submission_id,
    seq: r.seq,
    session_id: r.session_id,
    t: r.t,
    wall: r.wall.toISOString(),
    kind: r.kind,
    payload: r.payload,
    prev_hash: r.prev_hash,
    hash: r.hash,
  }));

  const result: EventQueryResult = { items, next_cursor };
  if (shouldCountTotal && countResult !== null && countResult.length > 0) {
    result.total_count = countResult[0]!.count;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single event by seq
// ---------------------------------------------------------------------------

export async function getEventBySeq(
  db: DrizzleDb,
  submissionId: string,
  seq: number,
): Promise<EventRow | null> {
  const rows = await db
    .select({
      submission_id: events.submission_id,
      seq: events.seq,
      session_id: events.session_id,
      t: events.t,
      wall: events.wall,
      kind: events.kind,
      payload: events.payload,
      prev_hash: events.prev_hash,
      hash: events.hash,
    })
    .from(events)
    .where(and(eq(events.submission_id, submissionId), eq(events.seq, seq)))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;

  return {
    submission_id: r.submission_id,
    seq: r.seq,
    session_id: r.session_id,
    t: r.t,
    wall: r.wall.toISOString(),
    kind: r.kind,
    payload: r.payload,
    prev_hash: r.prev_hash,
    hash: r.hash,
  };
}
