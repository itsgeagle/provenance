/**
 * RecomputeProgress tests — Phase 24.
 *
 * Tests:
 * 1. Shows loading state when job data not yet available.
 * 2. Shows running status + progress bar with correct percentage.
 * 3. Shows terminal success state + close button.
 * 4. Shows terminal partial state.
 * 5. Shows terminal failed state.
 * 6. Close button calls onClose.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { RecomputeProgress } from './RecomputeProgress.js';
import { DEFAULT_SEMESTER_ID, DEFAULT_SEMESTER_SLUG } from '../../test/msw-handlers.js';

const DEFAULT_JOB_ID = 'a1000000-0000-4000-8000-000000000001';

function makeRecomputeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: DEFAULT_JOB_ID,
    semester_id: DEFAULT_SEMESTER_ID,
    target_config_id: 'a0000000-0000-4000-8000-000000000001',
    triggered_by: 'a0000000-0000-4000-8000-000000000002',
    status: 'running',
    progress_total: 100,
    progress_done: 42,
    progress_failed: 0,
    created_at: '2025-01-10T12:00:00.000Z',
    started_at: '2025-01-10T12:00:01.000Z',
    completed_at: null,
    summary: null,
    ...overrides,
  };
}

function renderProgress(overrides: Record<string, unknown> = {}, onClose = vi.fn()) {
  mswServer.use(
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/recompute/${DEFAULT_JOB_ID}`, () =>
      HttpResponse.json(makeRecomputeJob(overrides)),
    ),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RecomputeProgress
          semesterId={DEFAULT_SEMESTER_ID}
          jobId={DEFAULT_JOB_ID}
          semesterSlug={DEFAULT_SEMESTER_SLUG}
          onClose={onClose}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecomputeProgress', () => {
  it('shows loading state initially', () => {
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/recompute/${DEFAULT_JOB_ID}`, async () => {
        // slow response — never resolves in this test
        await new Promise(() => {});
        return HttpResponse.json({});
      }),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RecomputeProgress
            semesterId={DEFAULT_SEMESTER_ID}
            jobId={DEFAULT_JOB_ID}
            semesterSlug={DEFAULT_SEMESTER_SLUG}
            onClose={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('recompute-progress-loading')).toBeInTheDocument();
  });

  it('shows running status with progress bar', async () => {
    renderProgress({ status: 'running', progress_done: 42, progress_total: 100 });

    await waitFor(
      () => {
        expect(screen.getByTestId('recompute-progress')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText(/Running/)).toBeInTheDocument();
    expect(screen.getByText(/42 \/ 100/)).toBeInTheDocument();
    expect(screen.getByTestId('progress-bar')).toBeInTheDocument();
  });

  it('shows succeeded terminal state with close button', async () => {
    renderProgress({
      status: 'succeeded',
      progress_done: 100,
      progress_total: 100,
      completed_at: '2025-01-10T12:05:00.000Z',
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('recompute-progress')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText(/Succeeded/)).toBeInTheDocument();
    expect(screen.getByTestId('recompute-close-btn')).toBeInTheDocument();
  });

  it('shows partial state', async () => {
    renderProgress({
      status: 'partial',
      progress_done: 95,
      progress_total: 100,
      progress_failed: 5,
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('recompute-progress')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText(/Partial/)).toBeInTheDocument();
    expect(screen.getByText(/5 failed/)).toBeInTheDocument();
  });

  it('shows failed terminal state', async () => {
    renderProgress({
      status: 'failed',
      completed_at: '2025-01-10T12:06:00.000Z',
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('recompute-progress')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByTestId('recompute-close-btn')).toBeInTheDocument();
  });

  it('close button calls onClose', async () => {
    const onClose = vi.fn();
    renderProgress({ status: 'succeeded' }, onClose);

    await waitFor(
      () => {
        expect(screen.getByTestId('recompute-close-btn')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByTestId('recompute-close-btn'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
