/**
 * HomeView — lists accessible semesters for the authenticated user.
 *
 * Data: derives semesters from GET /me memberships (useSemesters()).
 * Each item links to /s/:courseSlug/:semesterSlug (the cohort view).
 *
 * Empty state: "Ask an admin to invite you." message when memberships is [].
 */

import { Link } from 'react-router-dom';
import { useSemesters } from '../../api/queries.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';

export function HomeView() {
  const { data: semesters, isLoading, error } = useSemesters();

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <span className="text-sm text-muted-foreground">Loading semesters…</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <span className="text-sm text-destructive">
          Failed to load semesters. Please refresh the page.
        </span>
      </div>
    );
  }

  if (!semesters || semesters.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground" data-testid="no-semesters-message">
          Ask an admin to invite you.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Your semesters</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a semester to review its submissions.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/local/load" data-testid="local-analysis-link">
            Local analysis
            <span aria-hidden="true">→</span>
          </Link>
        </Button>
      </div>

      <ul className="space-y-2.5" data-testid="semester-list">
        {semesters.map((s) => (
          <li key={s.semester_id}>
            <Link
              to={`/s/${s.course_slug}/${s.semester_slug}`}
              data-testid={`semester-link-${s.semester_slug}`}
              className="group flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3.5 shadow-sm transition-colors hover:border-orange-300 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {s.course_slug} — {s.semester_slug}
                </span>
                <Badge variant="secondary" className="mt-1.5 capitalize">
                  {s.role}
                </Badge>
              </span>
              <span
                aria-hidden="true"
                className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-orange-700"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
