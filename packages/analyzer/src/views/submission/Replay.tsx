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
 * Session selection: URL ?session=… is the source of truth. A dropdown is
 * shown above ReplayInner only when the submission has >1 session.
 */

import { useEffect, useMemo } from 'react';
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
  const [searchParams, setSearchParams] = useSearchParams();

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

  // Reconcile the URL when the user landed without ?session=, or with an
  // invalid one. Replace (not push) so the back button still leaves the tab.
  useEffect(() => {
    if (sessionId === null) return;
    if (urlSession === sessionId) return;
    const next = new URLSearchParams(searchParams);
    next.set('session', sessionId);
    setSearchParams(next, { replace: true });
  }, [sessionId, urlSession, searchParams, setSearchParams]);

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

  const showSwitcher = sessionIds.length > 1;

  // Bound here rather than read inside the handler: TS does not carry the
  // `index !== undefined` narrowing above into a hoisted function declaration.
  const bySessionId = index.bySessionId;

  function handleSessionChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const target = e.target.value;
    const next = new URLSearchParams(searchParams);
    next.set('session', target);
    // The playhead is whole-bundle, not session-relative, so switching sessions
    // is a SEEK to that session's first event rather than a reset. (This used to
    // delete ?event= entirely, which discarded the position.)
    const firstOfSession = bySessionId.get(target)?.[0];
    if (firstOfSession !== undefined) {
      next.set('event', String(firstOfSession.globalIdx));
    } else {
      next.delete('event');
    }
    setSearchParams(next);
  }

  return (
    <div className="flex h-full flex-col" data-testid="replay-tab-shell">
      {showSwitcher && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-1.5 text-xs"
          data-testid="replay-session-switcher"
        >
          <label htmlFor="replay-session-select" className="font-medium text-gray-600">
            Session
          </label>
          <select
            id="replay-session-select"
            value={sessionId}
            onChange={handleSessionChange}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {sessionIds.map((id, idx) => {
              const events = index.bySessionId.get(id);
              const eventCount = events?.length ?? 0;
              const startWall = events?.[0]?.wall ?? null;
              const label =
                startWall !== null
                  ? `${idx + 1}. ${new Date(startWall).toLocaleString()} (${eventCount} events)`
                  : `${idx + 1}. ${id.slice(0, 8)}… (${eventCount} events)`;
              return (
                <option key={id} value={id}>
                  {label}
                </option>
              );
            })}
          </select>
          <span className="ml-2 font-mono text-[10px] text-gray-400">{sessionId.slice(0, 8)}…</span>
        </div>
      )}
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
