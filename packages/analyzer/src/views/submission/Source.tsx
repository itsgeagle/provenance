/**
 * Source tab — shows submitted files with Check 8 verdict badges and file content.
 *
 * Phase E4. Uses provider.useSubmittedFiles() and provider.useSubmittedFileContent().
 *
 * States handled:
 * - Loading / error
 * - available:false (bundle retention-swept)
 * - Empty (format 1.0, no submission files)
 * - Normal: file list with verdict badge + content panel on select
 */

import { useState } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

// ---------------------------------------------------------------------------
// Verdict badge styling
// ---------------------------------------------------------------------------

const VERDICT_STYLE: Record<string, string> = {
  match: 'text-green-700 bg-green-50',
  mismatch: 'text-red-700 bg-red-50',
  unknown: 'text-gray-600 bg-gray-100',
};

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export function Source() {
  const provider = useSubmissionData();
  const filesQ = provider.useSubmittedFiles();
  const [selected, setSelected] = useState<string | null>(null);
  const contentQ = provider.useSubmittedFileContent(selected ?? '');

  if (filesQ.isLoading) {
    return (
      <StatusRegion className="p-6 text-sm text-gray-600">
        <div data-testid="source-loading">Loading…</div>
      </StatusRegion>
    );
  }

  if (filesQ.isError) {
    return (
      <ErrorRegion className="p-6 text-sm text-red-600">
        <div data-testid="source-error">Failed to load submitted files.</div>
      </ErrorRegion>
    );
  }

  const data = filesQ.data;

  if (!data || !data.available) {
    return (
      <div className="p-6 text-sm text-gray-500" data-testid="source-unavailable">
        Submitted source is unavailable (the bundle has been retention-swept).
      </div>
    );
  }

  if (data.files.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-500" data-testid="source-empty">
        This bundle carries no submission files (recorder format 1.0).
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-testid="source-panel">
      {/* File list */}
      <ul className="w-72 shrink-0 overflow-auto border-r border-gray-200 bg-white">
        {data.files.map((f) => (
          <li key={f.path}>
            <button
              onClick={() => setSelected(f.path)}
              className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-gray-50 ${selected === f.path ? 'bg-gray-100' : ''}`}
            >
              <span className="truncate font-mono">{f.path}</span>
              <span
                data-testid={`verdict-${f.path}`}
                className={`rounded px-1.5 py-0.5 text-xs ${VERDICT_STYLE[f.verdict] ?? VERDICT_STYLE['unknown']}`}
              >
                {f.status === 'missing' ? 'missing' : f.verdict}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Content panel */}
      <div className="min-w-0 flex-1 overflow-auto bg-gray-50 p-4">
        {selected === null ? (
          <div className="text-sm text-gray-500" data-testid="source-no-selection">
            Select a file to view its submitted content.
          </div>
        ) : contentQ.isLoading ? (
          <StatusRegion className="text-sm text-gray-600">
            <div data-testid="source-content-loading">Loading…</div>
          </StatusRegion>
        ) : (
          <pre
            className="whitespace-pre-wrap break-words font-mono text-xs"
            data-testid="source-content"
          >
            {contentQ.data?.content ?? ''}
          </pre>
        )}
      </div>
    </div>
  );
}
