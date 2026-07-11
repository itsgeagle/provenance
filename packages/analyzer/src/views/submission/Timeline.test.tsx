/**
 * Timeline.test.tsx — accessibility regression test for the Timeline tab's
 * async loading/error states (WCAG 4.1.3 Status Messages).
 *
 * Full behavioral coverage of filtering/event rendering lives elsewhere; this
 * file focuses on the loading/error regions introduced in Task 14.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  ValidationResults,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';
import { Timeline } from './Timeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: true,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

function makeLoadingResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isPending: true,
    isSuccess: false,
    error: null,
    status: 'pending',
    fetchStatus: 'fetching',
  } as unknown as UseQueryResult<T>;
}

function makeErrorResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    isPending: false,
    isSuccess: false,
    error: new Error('boom'),
    status: 'error',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

const DUMMY_SUMMARY: SubmissionSummary = {
  id: 'test',
  student: { sid: 'test', display_name: 'Test' },
  assignment: { assignment_id_str: 'hw1', label: 'HW1' },
  version_index: 1,
  score_total: 0,
  score_max_severity: null,
  validation_status: 'pass',
  validation_overall_detail: null,
  heuristic_config_version: 1,
  flag_count: 0,
  ingested_at: '2025-01-01T00:00:00.000Z',
};

const DUMMY_VALIDATION: ValidationResults = { overall: 'pass', checks: [] };

function makeProvider(eventsResult: UseQueryResult<EventRow[]>): SubmissionDataProvider {
  return {
    useSummary: () => makeQueryResult(DUMMY_SUMMARY),
    useEvents: () => eventsResult,
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () =>
      makeQueryResult({
        per_file: [],
        aggregate: { total_events: 0, total_saves: 0, total_sessions: 0, total_wall_ms: 0 },
      } as SubmissionStats),
    useValidation: () => makeQueryResult(DUMMY_VALIDATION),
    useFiles: () => makeQueryResult({ files: [] } as FileListResult),
    useFileContent: () =>
      makeQueryResult({ content: '', at_seq: 0, computed_at_ms: 0 } as FileContentResult),
    useFileProvenance: () =>
      makeQueryResult({ length: 0, provenance: [], at_seq: 0 } as FileProvenanceResult),
    useSubmittedFiles: () =>
      makeQueryResult({ available: true, files: [] } as SubmittedFileListResult),
    useSubmittedFileContent: (_path: string) =>
      makeQueryResult({
        path: '',
        content: '',
        status: 'missing',
        verdict: 'unknown',
      } as SubmittedFileContentResult),
  };
}

function renderTimeline(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Timeline />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Timeline tab', () => {
  it('renders the event list once loaded', () => {
    const provider = makeProvider(makeQueryResult([] as EventRow[]));
    renderTimeline(provider);

    expect(screen.getByTestId('submission-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-empty')).toBeInTheDocument();
  });

  it('shows loading state announced via role=status', () => {
    const provider = makeProvider(makeLoadingResult<EventRow[]>());
    renderTimeline(provider);

    const loadingEl = screen.getByTestId('timeline-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    const provider = makeProvider(makeErrorResult<EventRow[]>());
    renderTimeline(provider);

    const errorEl = screen.getByTestId('timeline-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });
});
