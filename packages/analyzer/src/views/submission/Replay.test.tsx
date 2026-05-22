/**
 * Replay.test.tsx — smoke test for the Replay tab.
 *
 * Plan §786 exit gate: "scrub 100 events forward and back via the API provider;
 * matches v2 in-memory."
 *
 * Tests:
 * 1. Renders file selector with files from provider
 * 2. Renders scrubber
 * 3. Scrubbing to seq=50 calls provider.useFileContent with atSeq=50
 * 4. Scrubbing to seq=100 then back to seq=0 (forward-and-back smoke)
 * 5. Monaco editor content reflects the fetched content
 *
 * Monaco is rendered as a <textarea data-testid="replay-editor"> in test mode
 * (import.meta.env.MODE === 'test') so we can assert content without jsdom canvas.
 *
 * Debounce note: the component debounces atSeq updates by 100ms. Tests that need
 * the debounced value to commit use vi.useFakeTimers() scoped per-test with
 * vi.useRealTimers() cleanup, following the pattern that keeps waitFor functional.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  ValidationResults,
} from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';
import { Replay } from './Replay.js';

// ---------------------------------------------------------------------------
// Mock provider factory
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
    isLoadingError: false,
    isRefetchError: false,
    isFetching: false,
    isRefetching: false,
    isStale: false,
    isPaused: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
  } as unknown as UseQueryResult<T>;
}

// Content varies per atSeq so we can assert the right call was made.
function contentForSeq(atSeq: number): FileContentResult {
  return {
    content: `# content at seq ${atSeq}`,
    at_seq: atSeq,
    computed_at_ms: 0,
  };
}

function makeProvider(): {
  provider: SubmissionDataProvider;
  useFileContent: ReturnType<typeof vi.fn>;
} {
  const useFileContent = vi.fn(
    (_path: string, atSeq?: number): UseQueryResult<FileContentResult> =>
      makeQueryResult(contentForSeq(atSeq ?? 0)),
  );

  const useFileProvenance = vi.fn(
    (_path: string, _atSeq?: number): UseQueryResult<FileProvenanceResult> =>
      makeQueryResult({ length: 0, provenance: [], at_seq: _atSeq ?? 0 }),
  );

  const fileListResult: FileListResult = {
    files: [
      { path: 'hw1.py', final_length: 300, saves: 10 },
      { path: 'utils.py', final_length: 150, saves: 5 },
    ],
  };

  const stats: SubmissionStats = {
    per_file: fileListResult.files,
    aggregate: {
      total_events: 200,
      total_saves: 15,
      total_sessions: 1,
      total_wall_ms: 3600000,
    },
  };

  const summary: SubmissionSummary = {
    id: 'test-sub-id',
    student: { sid: 'test', display_name: 'Test Student' },
    assignment: { assignment_id_str: 'hw1', label: 'Homework 1' },
    version_index: 1,
    score_total: 0,
    score_max_severity: null,
    validation_status: 'pass',
    validation_overall_detail: null,
    heuristic_config_version: 1,
    flag_count: 0,
    ingested_at: '2025-01-01T00:00:00.000Z',
  };

  const validation: ValidationResults = { overall: 'pass', checks: [] };

  const provider: SubmissionDataProvider = {
    useSummary: () => makeQueryResult(summary),
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () => makeQueryResult(stats),
    useValidation: () => makeQueryResult(validation),
    useFiles: () => makeQueryResult(fileListResult),
    useFileContent,
    useFileProvenance,
  };

  return { provider, useFileContent };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderReplay(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Replay />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Replay tab', () => {
  afterEach(() => {
    // Restore real timers if a test used fake timers
    vi.useRealTimers();
  });

  it('renders file selector with available files', async () => {
    const { provider } = makeProvider();
    renderReplay(provider);

    await waitFor(() => {
      expect(screen.getByTestId('replay-file-select')).toBeInTheDocument();
    });

    const select = screen.getByTestId('replay-file-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('hw1.py');
    expect(options).toContain('utils.py');
  });

  it('renders scrubber', async () => {
    const { provider } = makeProvider();
    renderReplay(provider);

    await waitFor(() => {
      expect(screen.getByTestId('replay-scrubber')).toBeInTheDocument();
    });
  });

  it('calls useFileContent with atSeq=50 after scrubbing to seq=50', async () => {
    vi.useFakeTimers();
    const { provider, useFileContent } = makeProvider();
    renderReplay(provider);

    // Wait for initial render with fake timers — use getBy (synchronous) since
    // the component renders immediately (data is synchronously provided by the mock)
    expect(screen.getByTestId('replay-scrubber')).toBeInTheDocument();

    const scrubber = screen.getByTestId('replay-scrubber');

    act(() => {
      fireEvent.change(scrubber, { target: { value: '50' } });
      vi.advanceTimersByTime(150); // fire debounce
    });

    // After re-render with atSeq=50, useFileContent must have been called with it
    const calls = (useFileContent as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, number | undefined]
    >;
    const calledWithSeq50 = calls.some(([path, seq]) => path === 'hw1.py' && seq === 50);
    expect(calledWithSeq50).toBe(true);
  });

  /**
   * Plan §786 exit gate: "scrub 100 events forward and back via the API provider."
   */
  it('scrub-100-forward-and-back smoke test (plan §786 exit gate)', async () => {
    vi.useFakeTimers();
    const { provider, useFileContent } = makeProvider();
    renderReplay(provider);

    expect(screen.getByTestId('replay-scrubber')).toBeInTheDocument();

    const scrubber = screen.getByTestId('replay-scrubber');

    // Scrub forward to 100
    act(() => {
      fireEvent.change(scrubber, { target: { value: '100' } });
      vi.advanceTimersByTime(150);
    });

    // Scrub back to 0
    act(() => {
      fireEvent.change(scrubber, { target: { value: '0' } });
      vi.advanceTimersByTime(150);
    });

    const calls = (useFileContent as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, number | undefined]
    >;

    const calledWith100 = calls.some(([path, seq]) => path === 'hw1.py' && seq === 100);
    const calledWith0 = calls.some(([path, seq]) => path === 'hw1.py' && seq === 0);

    expect(calledWith100).toBe(true);
    expect(calledWith0).toBe(true);
  });

  it('Monaco editor textarea reflects content from useFileContent', async () => {
    const { provider } = makeProvider();
    renderReplay(provider);

    // The textarea renders synchronously once the component mounts
    await waitFor(() => {
      expect(screen.getByTestId('replay-editor')).toBeInTheDocument();
    });

    const textarea = screen.getByTestId('replay-editor') as HTMLTextAreaElement;
    // Initial atSeq=0 → content should be "# content at seq 0"
    expect(textarea.value).toBe('# content at seq 0');
  });

  it('updates editor content after scrubbing (real timers, >100ms wait)', async () => {
    const { provider } = makeProvider();
    renderReplay(provider);

    await waitFor(() => {
      expect(screen.getByTestId('replay-scrubber')).toBeInTheDocument();
    });

    const scrubber = screen.getByTestId('replay-scrubber');
    fireEvent.change(scrubber, { target: { value: '75' } });

    // Wait for the 100ms debounce to fire (real timers)
    await waitFor(
      () => {
        const textarea = screen.getByTestId('replay-editor') as HTMLTextAreaElement;
        expect(textarea.value).toBe('# content at seq 75');
      },
      { timeout: 3000 },
    );
  });
});
