/**
 * V45 — /admin/courses/:courseId/semesters
 *
 * Lists semesters in a course, lets a superadmin create new semesters
 * (term + year + slug + display name + filename convention) and links into
 * the existing per-semester admin pages (settings, members, etc.) which
 * already exist at /s/:slug/...
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import {
  useAddSelfAsAdmin,
  useAdminCourses,
  useAdminSemesters,
  useCreateSemester,
  useMe,
} from '../../api/queries.js';
import { ApiError } from '../../api/client.js';
import type { CreateSemesterRequest } from '@provenance/shared/api-schemas';

const TERMS: ReadonlyArray<CreateSemesterRequest['term']> = ['fa', 'sp', 'su', 'wi'];

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg"
      data-testid="toast"
      role="alert"
    >
      <span>{message}</span>
      <button onClick={onClose} className="text-white/80 hover:text-white" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function AdminSemestersView() {
  const { courseId = '' } = useParams<{ courseId: string }>();
  const { data: coursesData } = useAdminCourses();
  const course = coursesData?.courses.find((c) => c.id === courseId);

  const { data, isLoading, error } = useAdminSemesters(courseId);
  const { mutate: createSemester, isPending: isCreating } = useCreateSemester(courseId);
  const { data: me } = useMe();
  const myEmail = me?.user.email ?? null;
  const {
    mutate: addSelfAsAdmin,
    isPending: isAddingSelf,
    variables: addingVars,
  } = useAddSelfAsAdmin(courseId);

  function handleAddSelf(semesterId: string) {
    if (myEmail === null) return;
    addSelfAsAdmin(
      { semesterId, email: myEmail },
      {
        onError: (err) => {
          setToast(err instanceof ApiError ? err.message : 'Failed to add you to this semester.');
        },
      },
    );
  }

  const [term, setTerm] = useState<CreateSemesterRequest['term']>('fa');
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [filenameConvention, setFilenameConvention] = useState(
    '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
  );
  const [toast, setToast] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (slug.trim() === '' || displayName.trim() === '' || filenameConvention.trim() === '') return;
    createSemester(
      {
        term,
        year,
        slug: slug.trim(),
        display_name: displayName.trim(),
        filename_convention: filenameConvention.trim(),
      },
      {
        onSuccess: () => {
          setSlug('');
          setDisplayName('');
        },
        onError: (err) => {
          setToast(err instanceof ApiError ? err.message : 'Failed to create semester.');
        },
      },
    );
  }

  return (
    <AdminLayout>
      <div className="mb-4 text-xs text-gray-500">
        <Link to="/admin/courses" className="hover:underline">
          ← Back to courses
        </Link>
      </div>
      <h2 className="mb-4 text-base font-semibold text-gray-900">
        {course?.name ?? 'Course'} <span className="text-gray-400">/ semesters</span>
      </h2>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-700">Create semester</h3>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs text-gray-600">
            Term
            <select
              value={term}
              onChange={(e) => setTerm(e.target.value as CreateSemesterRequest['term'])}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              data-testid="semester-term-select"
            >
              {TERMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-gray-600">
            Year
            <input
              type="number"
              value={year}
              min={2000}
              max={2100}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              data-testid="semester-year-input"
            />
          </label>

          <label className="text-xs text-gray-600">
            Slug
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="fa26"
              pattern="[a-z0-9-]+"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              data-testid="semester-slug-input"
            />
          </label>

          <label className="text-xs text-gray-600">
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Fall 2026"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              data-testid="semester-display-name-input"
            />
          </label>

          <label className="text-xs text-gray-600 sm:col-span-2">
            Filename convention (regex with named groups <code>sid</code> and{' '}
            <code>assignment_id</code>)
            <input
              type="text"
              value={filenameConvention}
              onChange={(e) => setFilenameConvention(e.target.value)}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
              data-testid="semester-filename-input"
            />
          </label>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={isCreating || slug.trim() === '' || displayName.trim() === ''}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              data-testid="create-semester-submit"
            >
              {isCreating ? 'Creating…' : 'Create semester'}
            </button>
          </div>
        </form>
      </div>

      {isLoading && (
        <div className="py-8 text-center text-sm text-gray-400">Loading semesters…</div>
      )}
      {error && (
        <div className="py-8 text-center text-sm text-red-500">Failed to load semesters.</div>
      )}

      {!isLoading && !error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="semesters-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Slug</th>
                <th className="px-4 py-2 text-left">Display name</th>
                <th className="px-4 py-2 text-left">Term/Year</th>
                <th className="px-4 py-2 text-left">Submissions</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.semesters.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No semesters yet.
                  </td>
                </tr>
              ) : (
                data?.semesters.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs">{s.slug}</td>
                    <td className="px-4 py-2 text-xs">{s.display_name}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {s.term} {s.year}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">{s.submission_count}</td>
                    <td className="px-4 py-2 text-right">
                      {s.my_role === null ? (
                        // Not a member yet: the per-semester pages resolve the
                        // semester from your membership list, so they can't load
                        // until you're added. Add yourself here first.
                        <button
                          type="button"
                          onClick={() => handleAddSelf(s.id)}
                          disabled={
                            myEmail === null || (isAddingSelf && addingVars?.semesterId === s.id)
                          }
                          className="text-xs text-indigo-700 hover:underline disabled:opacity-50"
                          data-testid={`add-me-${s.slug}`}
                        >
                          {isAddingSelf && addingVars?.semesterId === s.id
                            ? 'Adding…'
                            : 'Add me as admin'}
                        </button>
                      ) : (
                        <Link
                          to={`/s/${s.slug}/settings`}
                          className="text-xs text-indigo-700 hover:underline"
                        >
                          Open settings →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {toast !== null && <Toast message={toast} onClose={() => setToast(null)} />}
    </AdminLayout>
  );
}
