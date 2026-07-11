/**
 * HomeView — lists accessible semesters for the authenticated user.
 *
 * Data: derives semesters from GET /me memberships (useSemesters()).
 * Each item links to /s/:courseSlug/:semesterSlug (Phase 21's cohort view).
 * Clicking a link will 404/placeholder until Phase 21 is implemented.
 *
 * Empty state: "Ask an admin to invite you." message when memberships is [].
 */

import { Link } from 'react-router-dom';
import { useSemesters } from '../../api/queries.js';

export function HomeView() {
  const { data: semesters, isLoading, error } = useSemesters();

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <span className="text-sm text-gray-500">Loading semesters…</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <span className="text-sm text-red-600">
          Failed to load semesters. Please refresh the page.
        </span>
      </div>
    );
  }

  if (!semesters || semesters.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-gray-500" data-testid="no-semesters-message">
          Ask an admin to invite you.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Your Semesters</h1>
        <Link
          to="/local/load"
          data-testid="local-analysis-link"
          className="text-sm font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Local analysis <span aria-hidden="true">→</span>
        </Link>
      </div>
      <ul
        className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white"
        data-testid="semester-list"
      >
        {semesters.map((s) => (
          <li key={s.semester_id} className="flex items-center justify-between px-4 py-3">
            <div>
              <Link
                to={`/s/${s.course_slug}/${s.semester_slug}`}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                data-testid={`semester-link-${s.semester_slug}`}
              >
                {s.course_slug} — {s.semester_slug}
              </Link>
              <p className="mt-0.5 text-xs text-gray-500 capitalize">{s.role}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
