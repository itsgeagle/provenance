/**
 * RecomputeProgress — banner showing recompute job status.
 *
 * Phase 24.
 *
 * Polls GET /semesters/:semesterId/recompute/:jobId every 2 seconds while
 * the job is not in a terminal status (succeeded / partial / failed / cancelled).
 *
 * Terminal state shows "done" with a close button.
 */

import { useRecomputeJob } from '../../api/queries.js';

interface RecomputeProgressProps {
  semesterId: string;
  jobId: string;
  semesterSlug: string;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial (some failures)',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

export function RecomputeProgress({ semesterId, jobId, onClose }: RecomputeProgressProps) {
  const { data: job, isLoading } = useRecomputeJob(semesterId, jobId);

  if (isLoading || !job) {
    return (
      <div
        className="mx-4 mt-2 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-700"
        data-testid="recompute-progress-loading"
      >
        Loading recompute job…
      </div>
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(job.status);
  const progressTotal = job.progress_total ?? 0;
  const progressDone = job.progress_done ?? 0;
  const progressFailed = job.progress_failed ?? 0;
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  const statusLabel = STATUS_LABELS[job.status] ?? job.status;

  const bgColor = isTerminal
    ? job.status === 'succeeded'
      ? 'bg-green-50 border-green-200'
      : job.status === 'partial'
        ? 'bg-yellow-50 border-yellow-200'
        : 'bg-red-50 border-red-200'
    : 'bg-blue-50 border-blue-200';

  const textColor = isTerminal
    ? job.status === 'succeeded'
      ? 'text-green-800'
      : job.status === 'partial'
        ? 'text-yellow-800'
        : 'text-red-800'
    : 'text-blue-800';

  return (
    <div className={`mx-4 mt-2 p-3 border rounded ${bgColor}`} data-testid="recompute-progress">
      <div className={`flex items-center justify-between ${textColor}`}>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Recompute: {statusLabel}</span>
            {!isTerminal && (
              <span className="text-xs">
                {progressDone} / {progressTotal} ({progressPct}%)
              </span>
            )}
            {progressFailed > 0 && (
              <span className="text-xs text-red-600">{progressFailed} failed</span>
            )}
          </div>

          {/* Progress bar */}
          {progressTotal > 0 && (
            <div
              className="mt-2 h-1.5 bg-gray-200 rounded overflow-hidden"
              data-testid="progress-bar"
            >
              <div
                className={`h-full rounded transition-all ${
                  isTerminal && job.status !== 'succeeded' ? 'bg-yellow-400' : 'bg-blue-500'
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>

        {isTerminal && (
          <button
            onClick={onClose}
            className="ml-4 text-xs underline hover:no-underline shrink-0"
            data-testid="recompute-close-btn"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}
