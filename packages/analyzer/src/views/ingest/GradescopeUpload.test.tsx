/**
 * GradescopeUpload tests.
 *
 * - Validation: a non-.zip selection shows an error.
 * - Successful upload with a job_id POSTs to ingest:gradescope (then navigates).
 * - Roster-only response (job_id null) renders the in-place summary.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { DEFAULT_SEMESTER_ID, DEFAULT_SEMESTER_SLUG } from '../../test/msw-handlers.js';
import { GradescopeUpload } from './GradescopeUpload.js';

const GS_ROUTE = new RegExp(`/semesters/${DEFAULT_SEMESTER_ID}/ingest:gradescope$`);

function renderUpload() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/ingest`]}>
        <Routes>
          <Route
            path="/s/:semesterSlug/ingest"
            element={
              <GradescopeUpload
                semesterSlug={DEFAULT_SEMESTER_SLUG}
                semesterId={DEFAULT_SEMESTER_ID}
              />
            }
          />
          <Route path="/s/:semesterSlug/ingest/jobs/:jobId" element={<div>job page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GradescopeUpload', () => {
  it('renders the export drop zone', () => {
    renderUpload();
    expect(screen.getByTestId('gs-drop-zone')).toBeInTheDocument();
    expect(screen.getByText(/Drop the/)).toBeInTheDocument();
  });

  it('shows a validation error for a non-.zip file', async () => {
    renderUpload();
    const input = screen.getByTestId('gs-file-input') as HTMLInputElement;
    const txt = new File(['x'], 'export.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [txt] } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('gs-validation-error')).toHaveTextContent(/must be a .zip/);
    });
  });

  it('POSTs the archive on a successful upload with a job_id', async () => {
    let postCalled = false;
    mswServer.use(
      http.post(GS_ROUTE, () => {
        postCalled = true;
        return HttpResponse.json(
          {
            job_id: '11111111-1111-1111-1111-111111111111',
            roster: { added: 3, updated: 1 },
            bundles_processed: 2,
            submissions_queued: 3,
            skipped: [],
          },
          { status: 202 },
        );
      }),
    );

    renderUpload();
    const input = screen.getByTestId('gs-file-input') as HTMLInputElement;
    const zip = new File(['zip'], 'assignment_export.zip', { type: 'application/zip' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [zip] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('gs-upload-button'));
    });
    await waitFor(() => expect(postCalled).toBe(true), { timeout: 3000 });
  });

  it('renders the roster summary when the export has no bundles (job_id null)', async () => {
    mswServer.use(
      http.post(GS_ROUTE, () =>
        HttpResponse.json(
          {
            job_id: null,
            roster: { added: 5, updated: 0 },
            bundles_processed: 0,
            submissions_queued: 0,
            skipped: [{ folder_key: 'submission_1', reason: 'no_manifest' }],
          },
          { status: 200 },
        ),
      ),
    );

    renderUpload();
    const input = screen.getByTestId('gs-file-input') as HTMLInputElement;
    const zip = new File(['zip'], 'export.zip', { type: 'application/zip' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [zip] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('gs-upload-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('gs-result')).toBeInTheDocument();
      expect(screen.getByTestId('gs-result')).toHaveTextContent(/5 added/);
      expect(screen.getByTestId('gs-result')).toHaveTextContent(/skipped/);
    });
  });
});
