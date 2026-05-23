/**
 * CohortTable — virtualized table of submission rows.
 *
 * Backed by @tanstack/react-table for column definitions + sorting and
 * @tanstack/react-virtual for row virtualization (300px row height pool,
 * 52px per row).
 *
 * Columns per PRD §8.8 SubmissionRow:
 * - Student (sid + display_name)
 * - Assignment (assignment_id_str + label)
 * - Score (score_total) + max severity badge
 * - Flag counts (badges by severity)
 * - Top flags (up to 3 heuristic ids)
 * - Validation status
 * - Ingested at (relative time)
 * - Recompute status badge
 *
 * Sorting: clicking a header changes the sort in the parent via onSortChange.
 * Load more: explicit "Load more" button when next_cursor is non-null.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import type { SubmissionRow } from '@provenance/shared/api-schemas';
import type { CohortSort } from '../../api/queries.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

const SEV_COLOR: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-orange-100 text-orange-800',
  low: 'bg-yellow-100 text-yellow-800',
  info: 'bg-gray-100 text-gray-700',
};

function SeverityBadge({ sev, count }: { sev: string; count: number }) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${SEV_COLOR[sev] ?? SEV_COLOR['info']}`}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Validation status badge
// ---------------------------------------------------------------------------

const VAL_COLOR: Record<string, string> = {
  pass: 'bg-green-100 text-green-800',
  warn: 'bg-yellow-100 text-yellow-800',
  fail: 'bg-red-100 text-red-800',
};

function ValidationBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${VAL_COLOR[status] ?? 'bg-gray-100 text-gray-700'}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Recompute status badge
// ---------------------------------------------------------------------------

const RECOMPUTE_COLOR: Record<string, string> = {
  fresh: 'text-green-700',
  stale: 'text-yellow-600',
  recomputing: 'text-blue-600',
  error: 'text-red-600',
};

function RecomputeBadge({ status }: { status: string }) {
  return <span className={`text-xs ${RECOMPUTE_COLOR[status] ?? 'text-gray-500'}`}>{status}</span>;
}

// ---------------------------------------------------------------------------
// Sort column map: tanstack column id -> CohortSort value
// ---------------------------------------------------------------------------

const COLUMN_TO_SORT: Record<string, { asc: CohortSort; desc: CohortSort } | undefined> = {
  score: { asc: 'score_asc', desc: 'score_desc' },
  student: { asc: 'student_asc', desc: 'student_desc' },
  assignment: { asc: 'assignment_asc', desc: 'assignment_asc' },
  ingested: { asc: 'ingested_desc', desc: 'ingested_desc' }, // only desc is valid
};

// ---------------------------------------------------------------------------
// Column helper
// ---------------------------------------------------------------------------

const ch = createColumnHelper<SubmissionRow>();

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CohortTableProps {
  rows: SubmissionRow[];
  sort: CohortSort;
  onSortChange: (sort: CohortSort) => void;
  nextCursor: string | null;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}

export function CohortTable({
  rows,
  sort,
  onSortChange,
  nextCursor,
  onLoadMore,
  isLoadingMore,
}: CohortTableProps) {
  const navigate = useNavigate();
  const { semesterSlug } = useParams<{ semesterSlug: string }>();

  // Infinite-scroll sentinel: lives INSIDE the scrollable table container
  // (see parentRef below) so it's only visible to the IntersectionObserver
  // once the user has actually scrolled near the bottom. Observer roots
  // against parentRef rather than the document so an unscrolled table doesn't
  // immediately trip the sentinel just because it fits in the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Forward-declared here; assigned by the JSX below.
  const parentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    const root = parentRef.current;
    if (!node || !root || nextCursor === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isLoadingMore) {
            onLoadMore();
          }
        }
      },
      { root, rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, isLoadingMore, onLoadMore]);

  const columns = useMemo(
    () => [
      ch.accessor((r) => r.student.display_name, {
        id: 'student',
        header: 'Student',
        cell: (info) => (
          <div>
            <div className="text-sm font-medium text-gray-900">{info.getValue()}</div>
            <div className="text-xs text-gray-500">{info.row.original.student.sid}</div>
          </div>
        ),
      }),
      ch.accessor((r) => r.assignment.label, {
        id: 'assignment',
        header: 'Assignment',
        cell: (info) => (
          <div>
            <div className="text-sm text-gray-900">{info.getValue()}</div>
            <div className="text-xs text-gray-500">
              {info.row.original.assignment.assignment_id_str}
            </div>
          </div>
        ),
      }),
      ch.accessor('score_total', {
        id: 'score',
        header: 'Score',
        cell: (info) => (
          <div className="flex items-center gap-1.5">
            <span className="text-sm tabular-nums">{info.getValue().toFixed(1)}</span>
            <span
              className={`inline-flex h-2 w-2 rounded-full ${
                info.row.original.score_max_severity === 'high'
                  ? 'bg-red-500'
                  : info.row.original.score_max_severity === 'medium'
                    ? 'bg-orange-400'
                    : info.row.original.score_max_severity === 'low'
                      ? 'bg-yellow-400'
                      : 'bg-gray-300'
              }`}
              title={info.row.original.score_max_severity}
            />
          </div>
        ),
      }),
      ch.accessor('flag_counts', {
        id: 'flags',
        header: 'Flags',
        cell: (info) => {
          const fc = info.getValue();
          return (
            <div className="flex items-center gap-1">
              <SeverityBadge sev="high" count={fc.high} />
              <SeverityBadge sev="medium" count={fc.medium} />
              <SeverityBadge sev="low" count={fc.low} />
              <SeverityBadge sev="info" count={fc.info} />
            </div>
          );
        },
      }),
      ch.accessor('top_flags', {
        id: 'top_flags',
        header: 'Top Flags',
        cell: (info) => {
          const flags = info.getValue();
          if (flags.length === 0) return <span className="text-xs text-gray-400">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {flags.map((f) => (
                <span
                  key={f.heuristic_id}
                  className={`inline-flex items-center rounded px-1 py-0.5 text-xs ${SEV_COLOR[f.severity] ?? SEV_COLOR['info']}`}
                >
                  {f.heuristic_id.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          );
        },
      }),
      ch.accessor('validation_status', {
        id: 'validation',
        header: 'Validation',
        cell: (info) => <ValidationBadge status={info.getValue()} />,
      }),
      ch.accessor('ingested_at', {
        id: 'ingested',
        header: 'Ingested',
        cell: (info) => {
          const d = new Date(info.getValue());
          return (
            <span className="text-xs text-gray-500" title={info.getValue()}>
              {formatDistanceToNow(d, { addSuffix: true })}
            </span>
          );
        },
      }),
      ch.accessor('recompute_status', {
        id: 'recompute',
        header: 'Recompute',
        cell: (info) => <RecomputeBadge status={info.getValue()} />,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Server-side sorting: manual = true disables client sorting
    manualSorting: true,
  });

  // Virtualization setup. parentRef is declared above (alongside the
  // infinite-scroll observer setup) so both pieces share the same scroll
  // container reference.
  const ROW_HEIGHT = 52;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0) : 0;

  function handleHeaderClick(columnId: string) {
    const sortMap = COLUMN_TO_SORT[columnId];
    if (!sortMap) return;
    // Toggle: if currently sorted desc by this column, switch to asc; otherwise desc
    const isDescNow = sort === sortMap.desc && sortMap.desc !== sortMap.asc;
    onSortChange(isDescNow ? sortMap.asc : sortMap.desc);
  }

  function handleRowClick(submissionId: string) {
    if (!semesterSlug) return;
    void navigate(`/s/${semesterSlug}/sub/${submissionId}`);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={parentRef}
        className="overflow-auto rounded-md border border-gray-200 bg-white"
        style={{ maxHeight: '70vh' }}
        data-testid="cohort-table-scroll"
      >
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-gray-50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const isSortable = header.column.id in COLUMN_TO_SORT;
                  return (
                    <th
                      key={header.id}
                      className={`border-b border-gray-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-600 ${
                        isSortable ? 'cursor-pointer select-none hover:bg-gray-100' : ''
                      }`}
                      onClick={() => isSortable && handleHeaderClick(header.column.id)}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((vRow) => {
              const row = table.getRowModel().rows[vRow.index];
              if (!row) return null;
              return (
                <tr
                  key={row.id}
                  className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                  onClick={() => handleRowClick(row.original.id)}
                  data-testid={`cohort-row-${row.original.id}`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-3 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: paddingBottom }} />
              </tr>
            )}
          </tbody>
        </table>
        {/* Infinite-scroll sentinel lives INSIDE the scrollable parent so the
            IntersectionObserver (rooted on parentRef) only sees it after the
            user has actually scrolled near the bottom of the table. */}
        {nextCursor !== null && (
          <div
            ref={sentinelRef}
            className="flex justify-center py-3 text-xs text-gray-400"
            data-testid="cohort-load-more-sentinel"
          >
            {isLoadingMore ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </div>
  );
}
