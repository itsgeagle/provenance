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
 * Session selection: ?session= (or the session holding ?event=) is only an ENTRY
 * ANCHOR — where replay opens. It is never written back, because the playhead
 * roams the whole bundle and a URL that kept asserting one session would go stale
 * the moment playback crossed a seam. ?event= is the position of record, and the
 * session dropdown belongs to ReplayInner, which drives it off the playhead.
 */

import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { ReplayInner } from '../replay/ReplayView.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
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
  const [searchParams] = useSearchParams();

  const summaryQuery = provider.useSummary();
  const flagsQuery = provider.useFlags();
  const indexQuery = useFullEventIndex(submissionId);

  // Sessions known to the submission, in summary order.
  const sessionIds = useMemo(() => summaryQuery.data?.session_ids ?? [], [summaryQuery.data]);

  // Resolve the active session from the URL, falling back to the first.
  const urlSession = searchParams.get('session');
  const sessionId = useMemo(() => {
    if (urlSession !== null && sessionIds.includes(urlSession)) return urlSession;
    return sessionIds[0] ?? null;
  }, [urlSession, sessionIds]);

  const sourceFilename = summaryQuery.data?.source_filename ?? '';

  if (indexQuery.isLoading || summaryQuery.isLoading) {
    return (
      <StatusRegion className="container mx-auto py-12 text-center text-gray-600">
        <p className="text-sm" data-testid="replay-loading">
          Loading replay data…
        </p>
      </StatusRegion>
    );
  }

  if (indexQuery.isError) {
    return (
      <ErrorRegion className="container mx-auto py-12 text-center text-red-600">
        <p className="text-sm" data-testid="replay-error">
          Failed to load events: {String(indexQuery.error)}
        </p>
      </ErrorRegion>
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

  // The session dropdown is ReplayInner's — it reads the playhead, so it stays
  // correct as playback crosses seams and it seeks instead of rewriting the URL.
  return (
    <div className="flex h-full flex-col" data-testid="replay-tab-shell">
      <div className="min-h-0 flex-1">
        <ReplayInner
          sessionId={sessionId}
          index={index}
          flags={(flagsQuery.data ?? []).map(toFlag)}
          sourceFilename={sourceFilename}
          showHeader={false}
        />
      </div>
    </div>
  );
}
