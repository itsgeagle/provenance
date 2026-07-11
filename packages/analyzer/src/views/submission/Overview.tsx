/**
 * Overview tab — summary card, validation summary, files list, flags.
 *
 * Phase 23. Consumes SubmissionDataProvider via useSubmissionData().
 * Works with both ApiSubmissionDataProvider and InMemorySubmissionDataProvider.
 */

import { useMemo } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { collectActiveExtensions } from '../../extensions/collect-active-extensions.js';
import { ActiveExtensionsCard } from '../../extensions/ActiveExtensionsCard.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

// ---------------------------------------------------------------------------
// Severity chip
// ---------------------------------------------------------------------------

const SEVERITY_CLASSES: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-orange-100 text-orange-800',
  low: 'bg-yellow-100 text-yellow-800',
  info: 'bg-blue-100 text-blue-800',
};

function SeverityChip({ severity }: { severity: string }) {
  const cls = SEVERITY_CLASSES[severity] ?? 'bg-gray-100 text-gray-800';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}
      data-testid={`severity-chip-${severity}`}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ValidationStatusBadge
// ---------------------------------------------------------------------------

function ValidationStatusBadge({ status }: { status: string }) {
  const label = status.toUpperCase();
  const cls =
    status === 'pass'
      ? 'bg-green-100 text-green-800'
      : status === 'warn'
        ? 'bg-yellow-100 text-yellow-800'
        : status === 'fail'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-800';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}`}
      data-testid="validation-status-badge"
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview tab component
// ---------------------------------------------------------------------------

export function Overview() {
  const provider = useSubmissionData();
  const summaryQuery = provider.useSummary();
  const flagsQuery = provider.useFlags();
  const validationQuery = provider.useValidation();
  const filesQuery = provider.useFiles();
  const extEventsQuery = provider.useEvents({ kind: ['ext.snapshot', 'ext.activate'] });

  const activeExtensions = useMemo(() => {
    const events = extEventsQuery.data ?? [];
    return collectActiveExtensions(
      events.filter((e) => e.kind === 'ext.snapshot'),
      events.filter((e) => e.kind === 'ext.activate'),
    );
  }, [extEventsQuery.data]);

  if (summaryQuery.isLoading) {
    return (
      <StatusRegion className="p-8 text-gray-600">
        <div data-testid="overview-loading">Loading submission…</div>
      </StatusRegion>
    );
  }

  if (summaryQuery.isError) {
    return (
      <ErrorRegion className="p-8 text-red-600">
        <div data-testid="overview-error">Failed to load submission summary.</div>
      </ErrorRegion>
    );
  }

  const summary = summaryQuery.data;
  if (!summary) return null;

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="submission-overview">
      {/* Summary card */}
      <section
        className="bg-white rounded-lg border border-gray-200 p-5 space-y-3"
        data-testid="summary-card"
      >
        <h2 className="text-xl font-semibold text-gray-900">Submission</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
          <div>
            <dt className="text-gray-500">Student</dt>
            <dd className="font-medium" data-testid="summary-student">
              {summary.student.display_name}
              <span className="ml-1 text-gray-600">({summary.student.sid})</span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Assignment</dt>
            <dd className="font-medium" data-testid="summary-assignment">
              {summary.assignment.label ?? summary.assignment.assignment_id_str}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Score</dt>
            <dd className="font-medium" data-testid="summary-score">
              {summary.score_total !== null ? summary.score_total.toFixed(1) : '—'}
              {summary.score_max_severity && (
                <span className="ml-2">
                  <SeverityChip severity={summary.score_max_severity} />
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Validation</dt>
            <dd data-testid="summary-validation">
              {summary.validation_status ? (
                <ValidationStatusBadge status={summary.validation_status} />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Flag count</dt>
            <dd className="font-medium" data-testid="summary-flag-count">
              {summary.flag_count}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Ingested</dt>
            <dd className="font-medium" data-testid="summary-ingested-at">
              {new Date(summary.ingested_at).toLocaleDateString()}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Version</dt>
            <dd className="font-medium" data-testid="summary-version">
              v{summary.version_index}
            </dd>
          </div>
        </dl>
      </section>

      {/* Active extensions */}
      <ActiveExtensionsCard extensions={activeExtensions} />

      {/* Validation summary */}
      {validationQuery.data && (
        <section
          className="bg-white rounded-lg border border-gray-200 p-5"
          data-testid="validation-section"
        >
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Validation</h2>
            <ValidationStatusBadge status={validationQuery.data.overall} />
          </div>
          <div className="space-y-1">
            {validationQuery.data.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-2 text-sm py-1">
                <span
                  className={
                    check.status === 'pass'
                      ? 'text-green-600'
                      : check.status === 'fail'
                        ? 'text-red-600'
                        : check.status === 'warn'
                          ? 'text-yellow-600'
                          : 'text-gray-600'
                  }
                  data-testid={`check-status-${check.id}`}
                >
                  {check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–'}
                </span>
                <span className="font-medium text-gray-700">{check.id}</span>
                {check.detail && <span className="text-gray-500 truncate">{check.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Flags */}
      {flagsQuery.data && flagsQuery.data.length > 0 && (
        <section
          className="bg-white rounded-lg border border-gray-200 p-5"
          data-testid="flags-section"
        >
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Flags ({flagsQuery.data.length})
          </h2>
          <div className="space-y-2">
            {flagsQuery.data.map((flag) => (
              <div
                key={flag.id}
                className="flex items-center gap-3 text-sm py-2 border-b border-gray-100 last:border-0"
                data-testid={`flag-row-${flag.heuristic_id}`}
              >
                <SeverityChip severity={flag.severity} />
                <span className="font-medium text-gray-800">{flag.heuristic_id}</span>
                <span className="text-gray-500 text-xs ml-auto">
                  conf {(flag.confidence * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Files list */}
      {filesQuery.data && filesQuery.data.files.length > 0 && (
        <section
          className="bg-white rounded-lg border border-gray-200 p-5"
          data-testid="files-section"
        >
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Files ({filesQuery.data.files.length})
          </h2>
          <div className="space-y-1">
            {filesQuery.data.files.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-3 text-sm py-1.5"
                data-testid={`file-row-${file.path}`}
              >
                <code className="text-gray-700 flex-1">{file.path}</code>
                <span className="text-gray-500 text-xs">{file.saves} saves</span>
                {file.reconstruction_tainted && (
                  <span
                    className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded"
                    title="File reconstruction tainted (external edits or large paste)"
                  >
                    tainted
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
