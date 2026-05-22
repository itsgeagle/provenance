/**
 * ExportPanel tests — Phase 24.
 *
 * Tests:
 * 1. Renders format selector (markdown + pdf options).
 * 2. Renders "Generate Export" button.
 * 3. Markdown sync: shows ready state with download link.
 * 4. PDF async: shows polling state after submit.
 * 5. PDF async: after poll timeout shows stub message (uses fake timers).
 * 6. Error response shows error message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { ExportPanel } from './ExportPanel.js';

const SUBMISSION_ID = 'ssss0000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderExportPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/sp25/sub/${SUBMISSION_ID}?tab=export`]}>
        <Routes>
          <Route path="/s/:semesterSlug/sub/:submissionId" element={<ExportPanel />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

describe('ExportPanel', () => {
  it('renders format selectors and generate button', () => {
    renderExportPanel();

    expect(screen.getByTestId('format-markdown')).toBeInTheDocument();
    expect(screen.getByTestId('format-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('generate-export-btn')).toBeInTheDocument();
  });

  it('markdown format is selected by default', () => {
    renderExportPanel();

    const mdRadio = screen.getByTestId('format-markdown') as HTMLInputElement;
    expect(mdRadio.checked).toBe(true);
  });

  it('markdown sync: shows ready state with download link after export', async () => {
    mswServer.use(
      http.post(`/api/v1/submissions/${SUBMISSION_ID}/export`, () =>
        HttpResponse.json({
          artifact_id: 'a0000000-0000-4000-8000-000000000001',
          format: 'markdown',
          expires_at: '2025-01-17T12:00:00.000Z',
          download_url: 'https://storage.example.com/exports/report.md',
        }),
      ),
    );

    renderExportPanel();

    fireEvent.click(screen.getByTestId('generate-export-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('export-ready')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // The download link should be present
    const link = screen.getByTestId('export-download-link') as HTMLAnchorElement;
    expect(link.href).toContain('storage.example.com');
  });

  it('PDF async: shows polling state after submit', async () => {
    mswServer.use(
      http.post(`/api/v1/submissions/${SUBMISSION_ID}/export`, () =>
        HttpResponse.json({
          job_id: 'a0000000-0000-4000-8000-000000000002',
          status: 'queued',
        }),
      ),
    );

    renderExportPanel();

    // Select PDF format
    fireEvent.click(screen.getByTestId('format-pdf'));
    fireEvent.click(screen.getByTestId('generate-export-btn'));

    // While polling, should show polling indicator
    await waitFor(
      () => {
        expect(screen.getByTestId('export-polling')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('PDF async: after poll timeout shows stub message', async () => {
    mswServer.use(
      http.post(`/api/v1/submissions/${SUBMISSION_ID}/export`, () =>
        HttpResponse.json({
          job_id: 'a0000000-0000-4000-8000-000000000002',
          status: 'queued',
        }),
      ),
    );

    renderExportPanel();
    fireEvent.click(screen.getByTestId('format-pdf'));
    fireEvent.click(screen.getByTestId('generate-export-btn'));

    // Wait for the polling banner to appear (mutation resolved)
    await waitFor(
      () => {
        expect(screen.getByTestId('export-polling')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Wait for the stub setTimeout (POLL_INTERVAL_MS=2000ms) to fire and show error.
    // Extend timeout to 4500ms to outlast the 2000ms stub timer.
    await waitFor(
      () => {
        expect(screen.getByTestId('export-error')).toBeInTheDocument();
      },
      { timeout: 4500 },
    );
  }, 10000);

  it('error response shows error message', async () => {
    mswServer.use(
      http.post(`/api/v1/submissions/${SUBMISSION_ID}/export`, () =>
        HttpResponse.json(
          { error: { code: 'EXPORT_FORMAT_UNSUPPORTED', message: 'PDF not yet supported' } },
          { status: 422 },
        ),
      ),
    );

    renderExportPanel();
    fireEvent.click(screen.getByTestId('generate-export-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('export-error')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
