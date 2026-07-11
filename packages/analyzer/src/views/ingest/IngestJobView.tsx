/**
 * IngestJobView — job detail with per-file table, status counts, cancel.
 *
 * Route: /s/:courseSlug/:semesterSlug/ingest/jobs/:jobId
 *
 * - Polls GET /ingest/jobs/:jobId every 3s while not terminal.
 * - Shows status counts (matched, unmatched, duplicate, failed, superseded).
 * - Lists files in a table.
 * - Cancel button only when status='queued' or 'running'.
 */

import { useParams, Link } from 'react-router-dom';
import { useIngestJob, useCancelIngest } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running…',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  queued: 'text-yellow-700 bg-yellow-50',
  running: 'text-blue-700 bg-blue-50',
  succeeded: 'text-green-700 bg-green-50',
  partial: 'text-orange-700 bg-orange-50',
  failed: 'text-red-700 bg-red-50',
  cancelled: 'text-gray-700 bg-gray-100',
};

const FILE_STATUS_COLORS: Record<string, string> = {
  matched: 'text-green-700',
  unmatched: 'text-yellow-700',
  duplicate: 'text-gray-500',
  failed: 'text-red-600',
  superseded: 'text-gray-600',
  discarded: 'text-gray-600',
  pending: 'text-blue-600',
};

export function IngestJobView() {
  const { jobId = '' } = useParams<{ jobId: string }>();

  const { semesterId, basePath } = useActiveSemester();

  const { data: job, isLoading, error } = useIngestJob(jobId, semesterId);
  const { mutate: cancelJob, isPending: isCancelling } = useCancelIngest(semesterId);

  const isTerminal =
    job?.status === 'succeeded' ||
    job?.status === 'partial' ||
    job?.status === 'failed' ||
    job?.status === 'cancelled';

  const canCancel = job?.status === 'queued' || job?.status === 'running';

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-gray-600">
        Loading job…
      </div>
    );
  }

  if (error || !job) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-16 text-sm text-destructive"
        data-testid="job-error"
      >
        Failed to load job. Please try again.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Breadcrumb */}
      <div className="mb-4 text-xs text-gray-500">
        <Link to={`${basePath}/ingest`} className="hover:underline">
          Ingest
        </Link>
        {' / '}
        <span className="font-mono">{jobId.slice(0, 8)}…</span>
      </div>

      {/* Header */}
      <div className="mb-6 flex items-center gap-4" data-testid="job-header">
        <h1 className="text-xl font-semibold text-gray-900">Ingest Job</h1>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? 'text-gray-700 bg-gray-100'}`}
          data-testid="job-status"
        >
          {STATUS_LABELS[job.status] ?? job.status}
        </span>
        {!isTerminal && (
          <span className="text-xs text-gray-600 animate-pulse">Polling every 3s…</span>
        )}
      </div>

      {/* Summary counts */}
      <div className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-7" data-testid="job-summary">
        {Object.entries(job.summary).map(([key, count]) => (
          <div key={key} className="rounded-lg border border-gray-200 bg-white p-3 text-center">
            <div className="text-lg font-semibold text-gray-900">{count}</div>
            <div className="text-xs text-gray-500 capitalize">{key}</div>
          </div>
        ))}
      </div>

      {/* Cancel button */}
      {canCancel && (
        <div className="mb-4">
          <button
            onClick={() => cancelJob(jobId)}
            disabled={isCancelling}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            data-testid="cancel-button"
          >
            {isCancelling ? 'Cancelling…' : 'Cancel Job'}
          </button>
        </div>
      )}

      {/* Files table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm" data-testid="files-table">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Filename</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Student</th>
              <th className="px-4 py-2 text-left">Assignment</th>
              <th className="px-4 py-2 text-right">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {job.files.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-600">
                  No files yet.
                </td>
              </tr>
            ) : (
              job.files.map((file) => (
                <tr key={file.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{file.original_filename}</td>
                  <td
                    className={`px-4 py-2 text-xs font-medium capitalize ${FILE_STATUS_COLORS[file.status] ?? 'text-gray-700'}`}
                  >
                    {file.status}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {file.matched_student
                      ? `${file.matched_student.sid} — ${file.matched_student.display_name}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {file.matched_assignment
                      ? file.matched_assignment.label || file.matched_assignment.assignment_id_str
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600 text-right">
                    {(file.size_bytes / 1024).toFixed(1)} KB
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {job.files.length === 200 && (
        <p className="mt-2 text-xs text-gray-600">
          Showing first 200 files. Use the API to retrieve more.
        </p>
      )}
    </div>
  );
}
