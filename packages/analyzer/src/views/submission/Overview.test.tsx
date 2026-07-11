/**
 * Overview.test.tsx — accessibility regression test for the Overview tab's
 * async loading/error states (WCAG 4.1.3 Status Messages).
 *
 * Full behavioral coverage of the Overview tab's data rendering lives in
 * integration/e2e coverage; this file focuses on the loading/error regions
 * introduced in Task 14.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { Overview } from './Overview.js';

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

function makeProvider(summaryResult: UseQueryResult<SubmissionSummary>): SubmissionDataProvider {
  return {
    useSummary: () => summaryResult,
    useEvents: () => makeQueryResult([] as EventRow[]),
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

function renderOverview(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Overview />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Overview tab', () => {
  it('renders the summary once loaded', async () => {
    const provider = makeProvider(makeQueryResult(DUMMY_SUMMARY));
    renderOverview(provider);

    await waitFor(() => {
      expect(screen.getByTestId('submission-overview')).toBeInTheDocument();
    });
  });

  it('shows loading state announced via role=status', () => {
    const provider = makeProvider(makeLoadingResult<SubmissionSummary>());
    renderOverview(provider);

    const loadingEl = screen.getByTestId('overview-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    const provider = makeProvider(makeErrorResult<SubmissionSummary>());
    renderOverview(provider);

    const errorEl = screen.getByTestId('overview-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });
});
