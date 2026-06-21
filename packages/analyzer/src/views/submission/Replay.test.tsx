/**
 * Replay tab smoke tests — verify wiring between provider/index hook and the
 * v2 ReplayInner. The inner's own behavior (transport, scrubbing, gutter
 * decorations, jump targets) is covered by views/replay/ReplayView.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  ValidationResults,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';
import type { EventIndex } from '../../index/event-index.js';
import { buildIndexFromEventRows, type ServerEventRow } from '../../index/build-index.js';
import { Replay } from './Replay.js';

// ---------------------------------------------------------------------------
// Mock useFullEventIndex so we don't actually hit the network.
// ---------------------------------------------------------------------------

const mockIndexResult: { value: UseQueryResult<EventIndex> | null } = { value: null };

vi.mock('../../data/useFullEventIndex.js', () => ({
  useFullEventIndex: () => mockIndexResult.value,
}));

function makeQueryResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: true,
    isFetching: false,
    isStale: false,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

function loadingResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isPending: true,
    isSuccess: false,
    isFetching: true,
    isStale: false,
    error: null,
    status: 'pending',
    fetchStatus: 'fetching',
  } as unknown as UseQueryResult<T>;
}

// ---------------------------------------------------------------------------
// Synthetic single-session, single-file index for ReplayInner to consume.
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-1';

function buildSyntheticIndex(): EventIndex {
  const wallBase = 1_700_000_000_000;
  const rows: ServerEventRow[] = [
    {
      seq: 0,
      session_id: SESSION_ID,
      t: 0,
      wall: new Date(wallBase).toISOString(),
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 1,
      session_id: SESSION_ID,
      t: 100,
      wall: new Date(wallBase + 100).toISOString(),
      kind: 'doc.open',
      payload: { path: 'hw1.py', content: '' },
    },
    {
      seq: 2,
      session_id: SESSION_ID,
      t: 200,
      wall: new Date(wallBase + 200).toISOString(),
      kind: 'doc.change',
      payload: {
        path: 'hw1.py',
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'hello',
          },
        ],
      },
    },
  ];
  return buildIndexFromEventRows(rows);
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function makeProvider(): SubmissionDataProvider {
  const stats: SubmissionStats = {
    per_file: [{ path: 'hw1.py', final_length: 5, saves: 0 }],
    aggregate: {
      total_events: 3,
      total_saves: 0,
      total_sessions: 1,
      total_wall_ms: 200,
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
    source_filename: 'test.zip',
    session_ids: [SESSION_ID],
  };
  const files: FileListResult = { files: stats.per_file };
  const validation: ValidationResults = { overall: 'pass', checks: [] };

  return {
    useSummary: () => makeQueryResult(summary),
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () => makeQueryResult(stats),
    useValidation: () => makeQueryResult(validation),
    useFiles: () => makeQueryResult(files),
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

function renderReplay(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/s/cs61a/fa26/sub/test-sub-id']}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
            element={
              <SubmissionDataContext.Provider value={provider}>
                <Replay />
              </SubmissionDataContext.Provider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Replay tab (v3)', () => {
  beforeEach(() => {
    mockIndexResult.value = null;
  });

  it('shows loading state while the event index is being fetched', () => {
    mockIndexResult.value = loadingResult<EventIndex>();
    renderReplay(makeProvider());
    expect(screen.getByTestId('replay-loading')).toBeInTheDocument();
  });

  it('renders ReplayInner once index and summary are ready', async () => {
    mockIndexResult.value = makeQueryResult(buildSyntheticIndex());
    renderReplay(makeProvider());
    await waitFor(() => {
      expect(screen.getByTestId('replay-view')).toBeInTheDocument();
    });
  });

  it('shows no-session message when the picked session is missing from the index', async () => {
    // Index built without the SESSION_ID our summary points at.
    mockIndexResult.value = makeQueryResult(buildIndexFromEventRows([]));
    renderReplay(makeProvider());
    await waitFor(() => {
      expect(screen.getByTestId('replay-session-missing')).toBeInTheDocument();
    });
  });
});
