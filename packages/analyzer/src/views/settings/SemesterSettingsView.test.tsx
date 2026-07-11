/**
 * SemesterSettingsView tests.
 *
 * - Happy path: renders form pre-populated from /semesters/:id.
 * - Live regex tester: shows match/groups for valid regex + sample.
 * - Invalid regex: shows inline error and disables submit.
 * - Submit: calls PATCH /semesters/:id.
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
  semesterDetailHandler,
} from '../../test/msw-handlers.js';
import { SemesterSettingsView } from './SemesterSettingsView.js';

function renderSettingsView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/settings`]}
      >
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/settings" element={<SemesterSettingsView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SemesterSettingsView', () => {
  it('renders form pre-populated with semester data', async () => {
    mswServer.use(
      semesterDetailHandler({
        display_name: 'CS 61A Spring 2025',
        filename_convention: '(?<sid>\\d+)_(?<assignment_id>hw\\d+)',
      }),
    );

    renderSettingsView();

    await waitFor(
      () =>
        expect((screen.getByTestId('display-name-input') as HTMLInputElement).value).toBe(
          'CS 61A Spring 2025',
        ),
      { timeout: 3000 },
    );
    expect((screen.getByTestId('filename-convention-input') as HTMLInputElement).value).toContain(
      '(?<sid>',
    );
  });

  it('live regex tester shows match groups for valid regex and sample', async () => {
    mswServer.use(
      semesterDetailHandler({
        filename_convention: '(?<sid>\\d+)_(?<assignment_id>hw\\d+)',
      }),
    );

    renderSettingsView();

    // Wait for the form to be populated with the semester data
    await waitFor(
      () =>
        expect(
          (screen.getByTestId('filename-convention-input') as HTMLInputElement).value,
        ).toContain('(?<sid>'),
      { timeout: 3000 },
    );

    // Type a sample that matches
    const sampleInput = screen.getByTestId('regex-sample-input');
    fireEvent.change(sampleInput, { target: { value: '3031234_hw1' } });

    // Should show group values
    await waitFor(() => expect(screen.getByTestId('group-sid')).toHaveTextContent('3031234'), {
      timeout: 3000,
    });
    expect(screen.getByTestId('group-assignment_id')).toHaveTextContent('hw1');
  });

  it('shows regex error and disables submit for invalid regex', async () => {
    mswServer.use(semesterDetailHandler({ filename_convention: '' }));

    renderSettingsView();

    await waitFor(
      () => expect(screen.getByTestId('filename-convention-input')).toBeInTheDocument(),
      { timeout: 3000 },
    );

    fireEvent.change(screen.getByTestId('filename-convention-input'), {
      target: { value: '(?<invalid' },
    });

    await waitFor(() => expect(screen.getByTestId('regex-error')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('save-settings-btn')).toBeDisabled();
  });

  it('every field is retrievable by its label text', async () => {
    mswServer.use(
      semesterDetailHandler({
        display_name: 'CS 61A Spring 2025',
        filename_convention: '(?<sid>\\d+)_(?<assignment_id>hw\\d+)',
      }),
    );

    renderSettingsView();

    await waitFor(
      () =>
        expect((screen.getByTestId('display-name-input') as HTMLInputElement).value).toBe(
          'CS 61A Spring 2025',
        ),
      { timeout: 3000 },
    );

    expect(screen.getByLabelText('Display Name')).toBe(screen.getByTestId('display-name-input'));
    expect(screen.getByLabelText('Filename Convention (regex)')).toBe(
      screen.getByTestId('filename-convention-input'),
    );
    expect(screen.getByLabelText('Blob Retention (days)')).toBe(
      screen.getByTestId('blob-retention-input'),
    );
    expect(screen.getByLabelText('Derived Data Retention (days)')).toBe(
      screen.getByTestId('derived-retention-input'),
    );
    expect(screen.getByLabelText('Live Tester')).toBe(screen.getByTestId('regex-sample-input'));
  });

  it('an errored field exposes aria-invalid and aria-describedby pointing at the error text', async () => {
    mswServer.use(semesterDetailHandler({ filename_convention: '' }));

    renderSettingsView();

    await waitFor(
      () => expect(screen.getByTestId('filename-convention-input')).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const input = screen.getByTestId('filename-convention-input');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).not.toHaveAttribute('aria-describedby');

    fireEvent.change(input, { target: { value: '(?<invalid' } });

    await waitFor(() => expect(screen.getByTestId('regex-error')).toBeInTheDocument(), {
      timeout: 3000,
    });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const errorEl = screen.getByTestId('regex-error');
    expect(errorEl.id).toBe(describedBy);
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });

  it('calls PATCH /semesters/:id on submit', async () => {
    mswServer.use(semesterDetailHandler({ display_name: 'Old Name' }));

    let patchCalled = false;
    let patchBody: unknown;
    mswServer.use(
      http.patch(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}`, async ({ request }) => {
        patchCalled = true;
        patchBody = await request.json();
        return HttpResponse.json({
          semester: {
            id: DEFAULT_SEMESTER_ID,
            course_id: 'cc000000-0000-0000-0000-000000000001',
            slug: DEFAULT_SEMESTER_SLUG,
            term: 'Spring',
            year: 2025,
            display_name: 'New Name',
            filename_convention: '',
            blob_retention_days: 90,
            derived_retention_days: 365,
            archived: false,
            my_role: 'admin',
            created_at: '2025-01-01T00:00:00.000Z',
          },
        });
      }),
    );

    renderSettingsView();

    await waitFor(
      () =>
        expect((screen.getByTestId('display-name-input') as HTMLInputElement).value).toBe(
          'Old Name',
        ),
      { timeout: 3000 },
    );

    fireEvent.change(screen.getByTestId('display-name-input'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByTestId('save-settings-btn'));

    await waitFor(() => expect(patchCalled).toBe(true), { timeout: 3000 });
    expect((patchBody as Record<string, unknown>)['display_name']).toBe('New Name');
  });
});
