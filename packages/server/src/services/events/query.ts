/**
 * Events query — PRD §8.9. Serves GET /submissions/{id}/events.
 *
 * Events are no longer persisted in Postgres. This module parses the stored
 * bundle blob on demand (via loadSubmissionIndex, LRU-cached) and reproduces the
 * exact same rows the `events` table used to hold — `seq` is the global
 * chronological index (globalIdx) and `prev_hash`/`hash` come from the raw
 * envelope — then filters, orders, and paginates them in memory.
 *
 * The row shape, ordering, cursor semantics, and total_count opt-in rule are
 * preserved byte-for-byte from the SQL implementation so the API contract is
 * unchanged.
 *
 * total_count:
 *   Only included when at least one of `kind` / `file` / `session_id` is in the
 *   query (matches the previous cheap-count rule, PRD §8.9).
 *
 * Cursor format:
 *   base64 JSON { seq: int }. asc → seq > cursor.seq; desc → seq < cursor.seq.
 *   The seq field uses the global seq (globalIdx), not session-local seq.
 */

import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { loadSubmissionIndex } from '../bundle/load-index.js';
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

/**
 * Reproduce the rows the `events` table used to hold, from a parsed bundle +
 * index. Mirrors materialize-events.ts exactly: `seq` = globalIdx, ordered
 * chronologically; `prev_hash`/`hash`/`payload` from the raw envelope, looked up
 * by `${sessionId}:${session-local seq}`.
 */
export function buildEventRows(
  submissionId: string,
  bundle: Bundle,
  index: EventIndex,
): EventRow[] {
  type Envelope = (typeof bundle.sessions)[number]['events'][number];
  const envelopeMap = new Map<string, Envelope>();
  for (const session of bundle.sessions) {
    for (const envelope of session.events) {
      envelopeMap.set(`${session.sessionId}:${envelope.seq}`, envelope);
    }
  }

  const rows: EventRow[] = new Array(index.ordered.length);
  for (let i = 0; i < index.ordered.length; i++) {
    const ie = index.ordered[i]!;
    const envelope = envelopeMap.get(`${ie.sessionId}:${ie.seq}`);
    if (envelope === undefined) {
      throw new Error(
        `buildEventRows: envelope not found for ${ie.sessionId}:${ie.seq} (submission ${submissionId})`,
      );
    }
    rows[i] = {
      submission_id: submissionId,
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
  return rows;
}

function payloadPath(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object' && 'path' in payload) {
    const p = (payload as { path: unknown }).path;
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

export async function queryEvents(
  db: DrizzleDb,
  storage: StorageClient,
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

  // Parse the stored bundle and reproduce the full event-row list.
  const { bundle, index } = await loadSubmissionIndex(db, storage, submissionId);
  const allRows = buildEventRows(submissionId, bundle, index);

  // Precompute range bounds once.
  const kindSet = params.kind && params.kind.length > 0 ? new Set(params.kind) : null;
  const wallFromMs = params.wall_from !== undefined ? new Date(params.wall_from).getTime() : null;
  const wallToMs = params.wall_to !== undefined ? new Date(params.wall_to).getTime() : null;
  const cursor = params.cursor !== undefined ? decodeEventCursor(params.cursor) : null;

  // Apply all predicates (including the cursor predicate — matches the SQL
  // WHERE that both the page query and the count query shared).
  const filtered = allRows.filter((r) => {
    if (kindSet !== null && !kindSet.has(r.kind)) return false;
    if (params.seq_from !== undefined && r.seq < params.seq_from) return false;
    if (params.seq_to !== undefined && r.seq > params.seq_to) return false;
    if (params.t_from !== undefined && r.t < params.t_from) return false;
    if (params.t_to !== undefined && r.t > params.t_to) return false;
    if (wallFromMs !== null && new Date(r.wall).getTime() < wallFromMs) return false;
    if (wallToMs !== null && new Date(r.wall).getTime() > wallToMs) return false;
    if (params.file !== undefined && payloadPath(r.payload) !== params.file) return false;
    if (params.session_id !== undefined && r.session_id !== params.session_id) return false;
    if (cursor !== null) {
      if (order === 'seq_asc' && r.seq <= cursor.seq) return false;
      if (order === 'seq_desc' && r.seq >= cursor.seq) return false;
    }
    return true;
  });

  // Order by seq. allRows is globalIdx-ascending, so asc is already correct.
  if (order === 'seq_desc') filtered.reverse();

  // total_count opt-in per PRD §8.9 (counts the same filtered set, incl. cursor).
  const shouldCountTotal =
    (params.kind !== undefined && params.kind.length > 0) ||
    params.file !== undefined ||
    params.session_id !== undefined;

  const hasMore = filtered.length > limit;
  const items = hasMore ? filtered.slice(0, limit) : filtered;

  let next_cursor: string | null = null;
  if (hasMore && items.length > 0) {
    next_cursor = encodeEventCursor(items[items.length - 1]!.seq);
  }

  const result: EventQueryResult = { items, next_cursor };
  if (shouldCountTotal) {
    result.total_count = filtered.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single event by seq
// ---------------------------------------------------------------------------

export async function getEventBySeq(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  seq: number,
): Promise<EventRow | null> {
  const { bundle, index } = await loadSubmissionIndex(db, storage, submissionId);
  // globalIdx === position in index.ordered, so a valid seq indexes directly.
  if (seq < 0 || seq >= index.ordered.length) return null;
  const rows = buildEventRows(submissionId, bundle, index);
  return rows[seq] ?? null;
}
