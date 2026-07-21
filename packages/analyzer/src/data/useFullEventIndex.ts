/**
 * useFullEventIndex — fetches every event for a submission and builds an
 * EventIndex client-side so the v3 Replay tab can drive the existing v2
 * replay engine (engine-core, useReplayEngine, TransportBar, EventSidebar,
 * JumpControls, GutterDecorations, …).
 *
 * Pages through GET /submissions/:id/events?cursor=… until next_cursor is
 * null. Uses TanStack Query so React re-renders happen on completion and the
 * result is cached / re-used across tab re-mounts.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { EventRowSchema, type EventRow } from '@provenance/shared/api-schemas';
import { apiFetch } from '../api/client.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';

const PageSchema = z.object({
  items: z.array(EventRowSchema),
  next_cursor: z.string().nullable().optional(),
});

const PAGE_LIMIT = 2000;
// Hard cap on total events fetched to protect the browser from runaway
// sessions. Typical sessions are <5k events; flag if we ever hit this.
const MAX_EVENTS = 200_000;

async function fetchAllEvents(submissionId: string): Promise<EventRow[]> {
  const all: EventRow[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_LIMIT));
    if (cursor !== null) params.set('cursor', cursor);
    const page = await apiFetch(
      `/submissions/${submissionId}/events?${params.toString()}`,
      undefined,
      PageSchema,
    );
    all.push(...page.items);
    if (all.length > MAX_EVENTS) {
      throw new Error(`Refusing to load >${MAX_EVENTS} events for replay (got ${all.length}).`);
    }
    const next = page.next_cursor ?? null;
    if (next === null || page.items.length === 0) break;
    cursor = next;
  }

  return all;
}

export type UseFullEventIndexOptions = {
  /**
   * Gate the fetch. Defaults to true.
   *
   * Paging every event is the most expensive thing a submission view does, so
   * a consumer that only *sometimes* needs the index (the Overview tab, which
   * needs it only once a flag drawer is opened) passes `false` until then. The
   * query key is unchanged either way, so an index fetched by one tab is
   * immediately reused by the others.
   */
  enabled?: boolean;
};

export function useFullEventIndex(
  submissionId: string,
  options: UseFullEventIndexOptions = {},
): UseQueryResult<EventIndex> {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ['submission', submissionId, 'full-event-index'],
    queryFn: async (): Promise<EventIndex> => {
      const rows = await fetchAllEvents(submissionId);
      // EventRow shape from the API matches ServerEventRow exactly.
      return buildIndexFromEventRows(rows as unknown as ServerEventRow[]);
    },
    // The full index is expensive to build; cache aggressively. Invalidated
    // implicitly when a re-ingest produces a new submission row (different id).
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: enabled && submissionId !== '',
  });
}
