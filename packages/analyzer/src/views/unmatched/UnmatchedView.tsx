/**
 * UnmatchedView — lists unmatched files with attach and discard actions.
 *
 * Route: /s/:semesterSlug/unmatched
 *
 * - Lists unmatched ingest_files.
 * - "Attach" button opens modal with student + assignment selectors.
 * - "Discard" button with confirm dialog.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useSemesters,
  useUnmatchedFiles,
  useAttachUnmatched,
  useDiscardUnmatched,
  useRoster,
  useAssignments,
} from '../../api/queries.js';
import type { IngestFileSummary } from '@provenance/shared/api-schemas';
import { ApiError } from '../../api/client.js';

// ---------------------------------------------------------------------------
// Attach modal
// ---------------------------------------------------------------------------

interface AttachModalProps {
  file: IngestFileSummary;
  semesterId: string;
  onClose: () => void;
  onAttached: () => void;
}

function AttachModal({ file, semesterId, onClose, onAttached }: AttachModalProps) {
  const { data: roster } = useRoster(semesterId);
  const { data: assignmentsData } = useAssignments(semesterId);
  const { mutate: attach, isPending, error } = useAttachUnmatched(semesterId);

  const [studentId, setStudentId] = useState('');
  const [assignmentIdStr, setAssignmentIdStr] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId || !assignmentIdStr) return;
    attach(
      { ingestFileId: file.id, studentId, assignmentIdStr },
      {
        onSuccess: () => {
          onAttached();
          onClose();
        },
      },
    );
  }

  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="attach-modal"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Attach File</h2>
        <p className="mb-4 text-xs text-gray-500 font-mono">{file.original_filename}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Student</label>
            <select
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              required
              data-testid="student-select"
            >
              <option value="">Select a student…</option>
              {roster?.entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.sid} — {e.display_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Assignment</label>
            <select
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={assignmentIdStr}
              onChange={(e) => setAssignmentIdStr(e.target.value)}
              required
              data-testid="assignment-select"
            >
              <option value="">Select an assignment…</option>
              {assignmentsData?.items.map((a) => (
                <option key={a.id} value={a.assignment_id_str}>
                  {a.label} ({a.assignment_id_str})
                </option>
              ))}
            </select>
          </div>

          {errorMsg && (
            <p className="text-xs text-red-600" data-testid="attach-error">
              {errorMsg}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !studentId || !assignmentIdStr}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              data-testid="attach-submit"
            >
              {isPending ? 'Attaching…' : 'Attach'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function UnmatchedView() {
  const { semesterSlug = '' } = useParams<{ semesterSlug: string }>();

  const { data: semesters } = useSemesters();
  const membership = semesters?.find((s) => s.semester_slug === semesterSlug);
  const semesterId = membership?.semester_id ?? '';

  const { data, isLoading, error } = useUnmatchedFiles(semesterId);
  const { mutate: discard } = useDiscardUnmatched(semesterId);

  const [attachFile, setAttachFile] = useState<IngestFileSummary | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null); // ingestFileId

  function handleDiscard(fileId: string) {
    discard({ ingestFileId: fileId });
    setDiscardConfirm(null);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Unmatched Files</h1>

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="unmatched-error">
          Failed to load unmatched files.
        </div>
      )}

      {!isLoading && !error && semesterId && (
        <>
          {(data?.items ?? []).length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400" data-testid="unmatched-empty">
              No unmatched files. Great job!
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <table className="w-full text-sm" data-testid="unmatched-table">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Filename</th>
                    <th className="px-4 py-2 text-right">Size</th>
                    <th className="px-4 py-2 text-left">Error</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data?.items.map((file) => (
                    <tr key={file.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">{file.original_filename}</td>
                      <td className="px-4 py-2 text-xs text-gray-400 text-right">
                        {(file.size_bytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {file.error?.message ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setAttachFile(file)}
                            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            data-testid={`attach-btn-${file.id}`}
                          >
                            Attach
                          </button>
                          {discardConfirm === file.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                onClick={() => handleDiscard(file.id)}
                                className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                                data-testid={`discard-confirm-${file.id}`}
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDiscardConfirm(null)}
                                className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setDiscardConfirm(file.id)}
                              className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                              data-testid={`discard-btn-${file.id}`}
                            >
                              Discard
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Attach modal */}
      {attachFile && (
        <AttachModal
          file={attachFile}
          semesterId={semesterId}
          onClose={() => setAttachFile(null)}
          onAttached={() => setAttachFile(null)}
        />
      )}
    </div>
  );
}
