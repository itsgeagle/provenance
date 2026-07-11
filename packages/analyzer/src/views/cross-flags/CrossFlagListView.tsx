/**
 * CrossFlagListView — list of cross-submission flags for a semester.
 *
 * Phase 24. Route: /s/:courseSlug/:semesterSlug/cross-flags
 *
 * Features:
 * - Filters: heuristic_id, severity_min, submission_id.
 * - Cursor pagination via load-more button.
 * - Click row → navigate to /s/:courseSlug/:semesterSlug/cross-flags/:id
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCrossFlagList } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import type { CrossFlagDetailItem } from '@provenance/shared/api-schemas';
import type { CrossFlagFilters } from '../../api/queries.js';

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-orange-100 text-orange-700',
    low: 'bg-yellow-100 text-yellow-700',
    info: 'bg-gray-100 text-gray-600',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[severity] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CrossFlagListView
// ---------------------------------------------------------------------------

export function CrossFlagListView() {
  const navigate = useNavigate();

  const { semesterId, basePath } = useActiveSemester();

  // Filters
  const [heuristicId, setHeuristicId] = useState('');
  const [severityMin, setSeverityMin] = useState<CrossFlagFilters['severityMin']>(undefined);
  const [submissionId, setSubmissionId] = useState('');

  // Accumulated items across pages
  const [allItems, setAllItems] = useState<CrossFlagDetailItem[]>([]);
  const [activeCursor, setActiveCursor] = useState<string | undefined>(undefined);

  const filters: CrossFlagFilters = {
    ...(heuristicId ? { heuristicId } : {}),
    ...(severityMin ? { severityMin } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(activeCursor ? { cursor: activeCursor } : {}),
    limit: 25,
  };

  const { data, isLoading, isFetching } = useCrossFlagList(semesterId, filters);

  // When filter changes, reset accumulated list
  function applyFilters() {
    setActiveCursor(undefined);
    setAllItems([]);
  }

  // Merge new page into accumulated list
  const currentItems = data?.items ?? [];
  const displayItems = activeCursor !== undefined ? [...allItems, ...currentItems] : currentItems;

  function handleLoadMore() {
    if (data?.next_cursor) {
      const prevItems = displayItems;
      setAllItems(prevItems);
      setActiveCursor(data.next_cursor);
    }
  }

  function handleRowClick(crossFlagId: string) {
    void navigate(`${basePath}/cross-flags/${crossFlagId}`);
  }

  return (
    <div className="flex flex-col min-h-0 p-4" data-testid="cross-flag-list-view">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Cross-Submission Flags</h1>

      {/* Filter bar */}
      <div className="flex gap-3 mb-4 flex-wrap" data-testid="cross-flag-filters">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Heuristic ID</label>
          <input
            type="text"
            value={heuristicId}
            onChange={(e) => setHeuristicId(e.target.value)}
            placeholder="e.g. paste_shared_across_students"
            className="border border-gray-200 rounded px-2 py-1 text-xs w-56"
            data-testid="filter-heuristic-id"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Min Severity</label>
          <select
            value={severityMin ?? ''}
            onChange={(e) => {
              setSeverityMin((e.target.value as CrossFlagFilters['severityMin']) || undefined);
            }}
            className="border border-gray-200 rounded px-2 py-1 text-xs"
            data-testid="filter-severity-min"
          >
            <option value="">Any</option>
            <option value="info">Info</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Submission ID</label>
          <input
            type="text"
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            placeholder="UUID"
            className="border border-gray-200 rounded px-2 py-1 text-xs w-72"
            data-testid="filter-submission-id"
          />
        </div>

        <div className="flex flex-col gap-1 justify-end">
          <button
            onClick={applyFilters}
            className="px-3 py-1 border border-gray-300 text-xs rounded hover:bg-gray-50"
            data-testid="apply-filters-btn"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-sm text-gray-500" data-testid="cross-flag-loading">
          Loading cross-flags…
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Heuristic
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Severity
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Participants
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Created</th>
                </tr>
              </thead>
              <tbody data-testid="cross-flag-rows">
                {displayItems.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-600 text-sm">
                      No cross-flags found.
                    </td>
                  </tr>
                )}
                {displayItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                    onClick={() => handleRowClick(item.id)}
                    data-testid={`cross-flag-row-${item.id}`}
                  >
                    <td className="px-4 py-2 font-mono text-xs">{item.heuristic_id}</td>
                    <td className="px-4 py-2">
                      <SeverityBadge severity={item.severity} />
                    </td>
                    <td className="px-4 py-2 text-gray-600">{item.participants.length}</td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {new Date(item.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.next_cursor && (
            <div className="mt-3 flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={isFetching}
                className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                data-testid="load-more-btn"
              >
                {isFetching ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
