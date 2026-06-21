/**
 * useActiveSemester — resolves the active semester from the URL.
 *
 * Per-semester routes are course-qualified: /s/:courseSlug/:semesterSlug/*.
 * Semester slugs are unique only WITHIN a course (DB constraint
 * `semesters_course_id_slug_key` on (course_id, slug)), so two semesters in
 * different courses can share a slug (e.g. both "sp25"). Resolving by the
 * semester slug alone returns the first match and silently loads the wrong
 * course's data; we must match on the (course_slug, semester_slug) pair.
 *
 * This is the single place that maps the URL slugs to a membership/semesterId,
 * and `basePath` is the single source of truth for building per-semester links.
 */

import { useParams } from 'react-router-dom';
import type { Membership } from '@provenance/shared/api-schemas';
import { useSemesters } from './queries.js';

export interface ActiveSemester {
  /** Course slug segment from the URL ('' if absent). */
  courseSlug: string;
  /** Semester slug segment from the URL ('' if absent). */
  semesterSlug: string;
  /** The membership matching both slugs, or undefined if none matches. */
  membership: Membership | undefined;
  /** Resolved semester UUID, or '' when unresolved. */
  semesterId: string;
  /** `/s/:courseSlug/:semesterSlug` for building per-semester links, or '' if slugs are missing. */
  basePath: string;
  /** True while the underlying /me query is loading. */
  isLoading: boolean;
}

export function useActiveSemester(): ActiveSemester {
  const { courseSlug = '', semesterSlug = '' } = useParams<{
    courseSlug?: string;
    semesterSlug?: string;
  }>();
  const { data: semesters, isLoading } = useSemesters();

  const membership = semesters?.find(
    (s) => s.course_slug === courseSlug && s.semester_slug === semesterSlug,
  );

  return {
    courseSlug,
    semesterSlug,
    membership,
    semesterId: membership?.semester_id ?? '',
    basePath: courseSlug && semesterSlug ? `/s/${courseSlug}/${semesterSlug}` : '',
    isLoading,
  };
}
