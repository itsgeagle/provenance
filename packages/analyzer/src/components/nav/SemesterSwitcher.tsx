/**
 * SemesterSwitcher — dropdown listing user's accessible semesters.
 *
 * The currently active semester is determined by the :semesterSlug URL param
 * (from /s/:semesterSlug routes). Selecting a different semester navigates to
 * the same sub-path within that semester.
 *
 * If the user has only one semester, no switcher is rendered (nothing to switch).
 * If the user has no semesters, no switcher is rendered.
 */

import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useSemesters } from '../../api/queries.js';

export function SemesterSwitcher() {
  const { data: semesters } = useSemesters();
  const { semesterSlug } = useParams<{ semesterSlug?: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  if (!semesters || semesters.length <= 1) {
    return null;
  }

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newSlug = e.target.value;
    if (!newSlug || newSlug === semesterSlug) return;

    // Replace the current semesterSlug segment in the path with newSlug.
    // e.g. /s/sp25/students → /s/fa24/students
    if (semesterSlug && location.pathname.includes(semesterSlug)) {
      const newPath = location.pathname.replace(semesterSlug, newSlug);
      void navigate(newPath + location.search);
    } else {
      void navigate(`/s/${newSlug}`);
    }
  }

  return (
    <select
      value={semesterSlug ?? ''}
      onChange={handleChange}
      aria-label="Switch semester"
      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      data-testid="semester-switcher"
    >
      {semesters.map((s) => (
        <option key={s.semester_id} value={s.semester_slug}>
          {s.course_slug} — {s.semester_slug}
        </option>
      ))}
    </select>
  );
}
