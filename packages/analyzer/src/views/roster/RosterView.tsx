/**
 * RosterView — lists roster entries, CSV upload with diff preview modal.
 *
 * Route: /s/:semesterSlug/roster
 *
 * - Lists current roster entries (sid + display_name + email).
 * - "Upload CSV" button → modal with file picker → POST /roster:upload → show diff.
 * - "Commit" button on diff → POST /roster:commit.
 */

import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useSemesters, useRoster, useRosterUpload, useRosterCommit } from '../../api/queries.js';
import type { RosterDiff } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Upload/diff modal
// ---------------------------------------------------------------------------

interface UploadModalProps {
  semesterId: string;
  onClose: () => void;
  onCommitted: () => void;
}

function UploadModal({ semesterId, onClose, onCommitted }: UploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [diff, setDiff] = useState<RosterDiff | null>(null);
  const [acceptDeletions, setAcceptDeletions] = useState(false);

  const {
    mutate: upload,
    isPending: isUploading,
    error: uploadError,
  } = useRosterUpload(semesterId);
  const {
    mutate: commit,
    isPending: isCommitting,
    error: commitError,
  } = useRosterCommit(semesterId);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    upload(file, {
      onSuccess: (result) => {
        setDiff(result);
      },
    });
  }

  function handleCommit() {
    if (!diff) return;
    commit(
      { uploadId: diff.upload_id, acceptDeletions },
      {
        onSuccess: () => {
          onCommitted();
          onClose();
        },
      },
    );
  }

  const errorMsg =
    (uploadError instanceof Error ? uploadError.message : null) ||
    (commitError instanceof Error ? commitError.message : null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="upload-modal"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Upload Roster CSV</h2>

        {!diff ? (
          <>
            <p className="mb-4 text-sm text-gray-600">
              Required columns: <code className="font-mono">sid</code>,{' '}
              <code className="font-mono">display_name</code>. Optional:{' '}
              <code className="font-mono">email</code>.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleFileChange}
              data-testid="csv-input"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              data-testid="select-csv-btn"
            >
              {isUploading ? 'Parsing CSV…' : 'Select CSV file'}
            </button>

            {errorMsg && (
              <p className="mt-2 text-xs text-red-600" data-testid="upload-error">
                {errorMsg}
              </p>
            )}
          </>
        ) : (
          <>
            {/* Diff preview */}
            <div className="mb-4 rounded-lg bg-gray-50 p-4 text-sm" data-testid="diff-preview">
              <div className="grid grid-cols-2 gap-2">
                <div>Parsed rows</div>
                <div className="font-medium">{diff.parsed_rows}</div>
                <div className="text-green-700">To add</div>
                <div className="font-medium text-green-700" data-testid="diff-to-add">
                  +{diff.to_add}
                </div>
                <div className="text-yellow-700">To update</div>
                <div className="font-medium text-yellow-700" data-testid="diff-to-update">
                  {diff.to_update}
                </div>
                <div className="text-red-700">To delete</div>
                <div className="font-medium text-red-700" data-testid="diff-to-delete">
                  −{diff.to_delete}
                </div>
              </div>

              {diff.errors.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-red-600 mb-1">Parse warnings:</p>
                  <ul className="space-y-0.5">
                    {diff.errors.map((err, i) => (
                      <li key={i} className="text-xs text-red-600">
                        {err.row !== undefined ? `Row ${err.row}: ` : ''}
                        {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Accept deletions checkbox (only if there are deletions) */}
            {diff.to_delete > 0 && (
              <label className="mb-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acceptDeletions}
                  onChange={(e) => setAcceptDeletions(e.target.checked)}
                  className="mt-0.5"
                  data-testid="accept-deletions"
                />
                <span>
                  Delete {diff.to_delete} entries not present in CSV{' '}
                  <span className="text-red-600 font-medium">(destructive)</span>
                </span>
              </label>
            )}

            {errorMsg && (
              <p className="mb-2 text-xs text-red-600" data-testid="commit-error">
                {errorMsg}
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          {diff && (
            <button
              onClick={handleCommit}
              disabled={isCommitting}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              data-testid="commit-btn"
            >
              {isCommitting ? 'Committing…' : 'Commit'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function RosterView() {
  const { semesterSlug = '' } = useParams<{ semesterSlug: string }>();

  const { data: semesters } = useSemesters();
  const membership = semesters?.find((s) => s.semester_slug === semesterSlug);
  const semesterId = membership?.semester_id ?? '';

  const { data, isLoading, error } = useRoster(semesterId);
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-xl font-semibold text-gray-900">Roster</h1>
        <span className="text-sm text-gray-500">
          {data?.total_count !== undefined ? `${data.total_count} entries` : ''}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setShowUpload(true)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
          data-testid="upload-csv-btn"
        >
          Upload CSV
        </button>
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading roster…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="roster-error">
          Failed to load roster.
        </div>
      )}

      {!isLoading && !error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="roster-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">SID</th>
                <th className="px-4 py-2 text-left">Display Name</th>
                <th className="px-4 py-2 text-left">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.entries.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                    No roster entries. Upload a CSV to get started.
                  </td>
                </tr>
              ) : (
                data?.entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs">{entry.sid}</td>
                    <td className="px-4 py-2 text-xs">{entry.display_name}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{entry.email ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showUpload && (
        <UploadModal
          semesterId={semesterId}
          onClose={() => setShowUpload(false)}
          onCommitted={() => setShowUpload(false)}
        />
      )}
    </div>
  );
}
