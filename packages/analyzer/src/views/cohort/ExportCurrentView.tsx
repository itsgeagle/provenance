/**
 * ExportCurrentView — exports the currently visible rows as a CSV file.
 *
 * Scope: only the rows currently rendered in the table (no additional API
 * calls). Export-all-filtered-rows would require fetching all pages, which
 * is a future feature.
 *
 * Filename: `cohort-<semester>-<YYYYMMDD>.csv`
 *
 * CSV format (no library — the payload is small and well-structured):
 * - Header row with column names
 * - One data row per SubmissionRow
 * - Values with commas/quotes are wrapped in double-quotes; embedded
 *   double-quotes are escaped as ""
 */

import type { SubmissionRow } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  // If value contains comma, double-quote, or newline → wrap in quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(rows: SubmissionRow[]): string {
  const headers = [
    'submission_id',
    'student_sid',
    'student_name',
    'assignment',
    'score_total',
    'score_max_severity',
    'flags_high',
    'flags_medium',
    'flags_low',
    'flags_info',
    'top_flags',
    'validation_status',
    'ingested_at',
    'recompute_status',
    'superseded',
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    const topFlagsStr = row.top_flags.map((f) => f.heuristic_id).join(';');
    const cells = [
      row.id,
      row.student.sid,
      row.student.display_name,
      row.assignment.label || row.assignment.assignment_id_str,
      String(row.score_total),
      row.score_max_severity,
      String(row.flag_counts.high),
      String(row.flag_counts.medium),
      String(row.flag_counts.low),
      String(row.flag_counts.info),
      topFlagsStr,
      row.validation_status ?? '',
      row.ingested_at,
      row.recompute_status,
      String(row.superseded),
    ];
    lines.push(cells.map(csvEscape).join(','));
  }

  return lines.join('\n');
}

function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function downloadCsv(rows: SubmissionRow[], semesterSlug: string): void {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `cohort-${semesterSlug}-${formatDateYYYYMMDD(new Date())}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExportCurrentViewProps {
  rows: SubmissionRow[];
  semesterSlug: string;
}

export function ExportCurrentView({ rows, semesterSlug }: ExportCurrentViewProps) {
  function handleExport() {
    downloadCsv(rows, semesterSlug);
  }

  return (
    <button
      onClick={handleExport}
      disabled={rows.length === 0}
      className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      data-testid="export-button"
    >
      Export CSV ({rows.length} rows)
    </button>
  );
}
