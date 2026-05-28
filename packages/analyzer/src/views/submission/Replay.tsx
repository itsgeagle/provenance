/**
 * Replay tab — feeds the v2 ReplayInner (transport bar, event sidebar,
 * jump controls, real-time playback, gutter decorations) with data fetched
 * from the server API.
 *
 * Data flow:
 *  1. useFullEventIndex(submissionId) → pages /events and builds an EventIndex
 *  2. useSubmissionData().useSummary() → session_ids + source_filename
 *  3. useSubmissionData().useFlags() → flag list for "next flag" jumps
 *  4. <ReplayInner index={…} sessionId={…} flags={…} sourceFilename={…} showHeader={false}/>
 *
 * Phase 23 stub (file dropdown + scrubber + read-only Monaco) replaced.
 */

import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { ReplayInner } from '../replay/ReplayView.js';
import type { Flag } from '../../heuristics/types.js';
import type { FlagRow } from '@provenance/shared/api-schemas';

/**
 * Project the server's FlagRow shape onto the analyzer's Flag shape so the
 * v2 ReplayInner (and its JumpControls) can consume it. The recorder/analyzer
 * Flag carries free-form `title` / `description` which the server doesn't
 * persist — substitute the heuristic id so the sidebar tooltip is non-empty.
 */
function toFlag(row: FlagRow): Flag {
  const sessionId = row.session_id ?? '';
  const supportingSeqs = (row.supporting_seqs ?? []).map((seq) => `${sessionId}:${seq}`);
  return {
    id: row.id,
    heuristic: row.heuristic_id,
    title: row.heuristic_id,
    severity: row.severity,
    confidence: row.confidence,
    supportingSeqs,
    description: '',
    ...(row.detail !== null && typeof row.detail === 'object'
      ? { detail: row.detail as Record<string, unknown> }
      : {}),
  };
}

export function Replay() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const provider = useSubmissionData();

  const summaryQuery = provider.useSummary();
  const flagsQuery = provider.useFlags();
  const indexQuery = useFullEventIndex(submissionId);

  const sessionId = useMemo(() => {
    const ids = summaryQuery.data?.session_ids ?? [];
    return ids[0] ?? null;
  }, [summaryQuery.data]);

  const sourceFilename = summaryQuery.data?.source_filename ?? '';

  if (indexQuery.isLoading || summaryQuery.isLoading) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-loading"
      >
        <p className="text-sm">Loading replay data…</p>
      </div>
    );
  }

  if (indexQuery.isError) {
    return (
      <div
        className="container mx-auto py-12 text-center text-red-600"
        data-testid="replay-error"
      >
        <p className="text-sm">Failed to load events: {String(indexQuery.error)}</p>
      </div>
    );
  }

  const index = indexQuery.data;
  if (index === undefined || sessionId === null) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-no-session"
      >
        <p className="text-sm">No replayable session in this submission.</p>
      </div>
    );
  }

  if (!index.bySessionId.has(sessionId)) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-session-missing"
      >
        <p className="text-sm">Session {sessionId.slice(0, 8)}… not present in event stream.</p>
      </div>
    );
  }

  return (
    <ReplayInner
      sessionId={sessionId}
      index={index}
      flags={(flagsQuery.data ?? []).map(toFlag)}
      sourceFilename={sourceFilename}
      showHeader={false}
    />
  );
}
