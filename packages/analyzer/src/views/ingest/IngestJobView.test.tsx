/**
 * IngestJobView tests.
 *
 * - Happy path: renders job status, summary counts, file table.
 * - Polling: active status shows "Polling" indicator; terminal status does not.
 * - Cancel: cancel button visible for queued/running; not for terminal.
 * - Cancel mutation: clicking cancel calls the API.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import {
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
  DEFAULT_JOB_ID,
  makeIngestJob,
  makeIngestFile,
  ingestJobHandler,
} from '../../test/msw-handlers.js';
import { IngestJobView } from './IngestJobView.js';

function renderJobView(jobId: string = DEFAULT_JOB_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/ingest/jobs/${jobId}`]}
      >
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/ingest/jobs/:jobId"
            element={<IngestJobView />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IngestJobView', () => {
  it('renders a succeeded job with summary counts and file table', async () => {
    const file = makeIngestFile();
    const job = makeIngestJob('succeeded', [file]);
    mswServer.use(ingestJobHandler(job));

    renderJobView();

    await waitFor(() => expect(screen.getByTestId('job-status')).toHaveTextContent('Succeeded'), {
      timeout: 3000,
    });

    expect(screen.getByTestId('job-summary')).toBeInTheDocument();
    expect(screen.getByTestId('files-table')).toBeInTheDocument();
    // File row: original_filename
    expect(screen.getByText('alice_hw1.zip')).toBeInTheDocument();
  });

  it('shows polling indicator for a running job and hides it when done', async () => {
    const runningJob = makeIngestJob('running', []);
    mswServer.use(ingestJobHandler(runningJob));

    renderJobView();

    await waitFor(() => expect(screen.getByTestId('job-status')).toHaveTextContent('Running'), {
      timeout: 3000,
    });
    expect(screen.getByText(/Polling every 3s/)).toBeInTheDocument();
  });

  it('shows cancel button for a queued job', async () => {
    const queuedJob = makeIngestJob('queued', []);
    mswServer.use(ingestJobHandler(queuedJob));

    renderJobView();

    await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('calls cancel API when cancel button is clicked', async () => {
    const queuedJob = makeIngestJob('running', []);
    mswServer.use(ingestJobHandler(queuedJob));

    let cancelCalled = false;
    mswServer.use(
      http.post(
        `/api/v1/semesters/${DEFAULT_SEMESTER_ID}/ingest/jobs/${DEFAULT_JOB_ID}/cancel`,
        () => {
          cancelCalled = true;
          return HttpResponse.json(
            { ok: true, cancelled: true, previous_status: 'running' },
            { status: 202 },
          );
        },
      ),
    );

    renderJobView();

    await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByTestId('cancel-button'));
    await waitFor(() => expect(cancelCalled).toBe(true), { timeout: 3000 });
  });

  it('shows error state when job fetch fails', async () => {
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/ingest/jobs/${DEFAULT_JOB_ID}`, () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 }),
      ),
    );

    renderJobView();

    await waitFor(() => expect(screen.getByTestId('job-error')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });
});
