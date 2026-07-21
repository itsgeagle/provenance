/**
 * SessionsCard — the sessions a submission is made of, on the Overview tab.
 *
 * The /local Overview has always listed a bundle's sessions (SummaryStatsPanel);
 * the server-backed tab showed nothing, so a reviewer had no way to tell a
 * one-sitting submission from one spread over four days without opening Replay
 * and reading the session dropdown.
 *
 * Driven entirely by `summary.sessions`, which the summary endpoint derives from
 * the bundle index it already loads — so this costs no extra request and does
 * not need the (expensive) full event stream.
 *
 * Rendered only when there is more than one session; for a single session the
 * Replay tab already covers it.
 */

import { ChevronRight } from 'lucide-react';
import { formatDuration } from '../../lib/format.js';

export type SessionSummaryEntry = {
  session_id: string;
  started_at: string | null;
  event_count: number;
};

interface SessionsCardProps {
  sessions: SessionSummaryEntry[];
  /** Open this session in the Replay tab. */
  onOpenSession: (sessionId: string) => void;
}

export function SessionsCard({ sessions, onOpenSession }: SessionsCardProps) {
  if (sessions.length < 2) return null;

  const firstStart = sessions[0]?.started_at ?? null;
  const lastStart = sessions[sessions.length - 1]?.started_at ?? null;
  // The span between the first and last session start is the single most
  // useful number here: it says at a glance whether this was one sitting.
  const spanMs =
    firstStart !== null && lastStart !== null
      ? Date.parse(lastStart) - Date.parse(firstStart)
      : null;

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-5"
      data-testid="sessions-section"
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Sessions ({sessions.length})</h2>
        {spanMs !== null && spanMs > 0 && (
          <span className="text-xs text-gray-500" data-testid="sessions-span">
            spanning {formatDuration(spanMs)}
          </span>
        )}
      </div>
      <div className="space-y-1" data-testid="session-list">
        {sessions.map((session, i) => (
          <button
            key={session.session_id}
            type="button"
            onClick={() => onOpenSession(session.session_id)}
            className="flex w-full items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            data-testid={`session-row-${session.session_id}`}
          >
            <span className="min-w-0 truncate">
              <span className="font-medium text-gray-800">Session {i + 1}</span>
              {session.started_at !== null && (
                <span className="ml-2 text-xs text-gray-500">
                  {new Date(session.started_at).toLocaleString()}
                </span>
              )}
            </span>
            <span className="ml-4 flex shrink-0 items-center gap-3 text-xs text-gray-500">
              <span>
                {session.event_count.toLocaleString()} event
                {session.event_count !== 1 ? 's' : ''}
              </span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
