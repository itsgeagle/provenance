/**
 * UnmatchedView tests.
 *
 * - Happy path: renders unmatched files table.
 * - Empty state: message when no unmatched files.
 * - Attach modal: opens on Attach click; shows student and assignment selectors.
 * - Conflict warning: shows when (student, assignment) already has a submission.
 * - Confirm-overwrite: requires a second Attach click to call the API.
 * - Discard: shows confirm step; calls API on confirm.
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
  unmatchedHandler,
  rosterHandler,
  assignmentsHandler,
  cohortSubmissionsHandler,
  makeIngestFile,
  makeSubmissionRow,
} from '../../test/msw-handlers.js';
import { UnmatchedView } from './UnmatchedView.js';

const STUDENT_ID = 'a2000000-0000-0000-0000-000000000001';
const ROSTER_ENTRY = {
  id: STUDENT_ID,
  sid: '3031234',
  display_name: 'Alice',
  email: null,
  extras: null,
};

const UNMATCHED_FILE_ID = 'ff000000-0000-0000-0000-000000000001';

function renderUnmatchedView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/unmatched`]}
      >
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/unmatched" element={<UnmatchedView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UnmatchedView', () => {
  it('shows empty state when no unmatched files', async () => {
    mswServer.use(unmatchedHandler([]));

    renderUnmatchedView();

    await waitFor(() => expect(screen.getByTestId('unmatched-empty')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('renders unmatched files table', async () => {
    const file = makeIngestFile({ status: 'unmatched', original_filename: 'unknown.zip' });
    mswServer.use(unmatchedHandler([file]));

    renderUnmatchedView();

    await waitFor(() => expect(screen.getByTestId('unmatched-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('unknown.zip')).toBeInTheDocument();
  });

  it('opens attach modal on Attach click', async () => {
    const file = makeIngestFile({ id: UNMATCHED_FILE_ID, status: 'unmatched' });
    mswServer.use(unmatchedHandler([file]), rosterHandler([ROSTER_ENTRY], 1), assignmentsHandler());

    renderUnmatchedView();

    await waitFor(
      () => expect(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`));

    expect(screen.getByTestId('attach-modal')).toBeInTheDocument();
    // Should have searchable student + assignment comboboxes.
    expect(screen.getByTestId('student-select')).toBeInTheDocument();
    expect(screen.getByTestId('assignment-select')).toBeInTheDocument();
  });

  it('warns on conflict and requires second click to overwrite', async () => {
    const file = makeIngestFile({ id: UNMATCHED_FILE_ID, status: 'unmatched' });

    // Roster has Alice; assignments has hw1; existing submission ties them
    // together so picking (Alice, hw1) should surface the conflict warning.
    mswServer.use(
      unmatchedHandler([file]),
      rosterHandler([ROSTER_ENTRY], 1),
      assignmentsHandler(),
      cohortSubmissionsHandler([
        makeSubmissionRow({
          student: { id: STUDENT_ID, sid: '3031234', display_name: 'Alice' },
        }),
      ]),
    );

    let attachCalled = 0;
    mswServer.use(
      http.patch(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/unmatched/${UNMATCHED_FILE_ID}`, () => {
        attachCalled += 1;
        return HttpResponse.json({
          id: UNMATCHED_FILE_ID,
          original_filename: 'alice_hw1.zip',
          size_bytes: 1024,
          blob_sha256: 'abc',
          status: 'matched',
          warnings: [],
        });
      }),
    );

    renderUnmatchedView();

    await waitFor(
      () => expect(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`));

    // Focus the student combobox input to open its popup, then pick Alice.
    const studentCombo = screen.getByTestId('student-select');
    const studentInput = studentCombo.querySelector('input');
    expect(studentInput).not.toBeNull();
    fireEvent.focus(studentInput!);
    await waitFor(
      () => expect(screen.getByTestId(`combobox-option-${STUDENT_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.mouseDown(screen.getByTestId(`combobox-option-${STUDENT_ID}`));

    // Now the assignment combobox should be enabled and show hw1.
    // Open it explicitly (focus the input inside the combobox).
    const assignmentCombo = screen.getByTestId('assignment-select');
    const assignmentInput = assignmentCombo.querySelector('input');
    expect(assignmentInput).not.toBeNull();
    fireEvent.focus(assignmentInput!);

    await waitFor(() => expect(screen.getByTestId('combobox-option-hw1')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.mouseDown(screen.getByTestId('combobox-option-hw1'));

    // Conflict warning shows; attach button should require a second click.
    await waitFor(() => expect(screen.getByTestId('conflict-warning')).toBeInTheDocument(), {
      timeout: 3000,
    });

    // First Attach click — switches to confirm step, does NOT call the API.
    fireEvent.click(screen.getByTestId('attach-submit'));
    expect(attachCalled).toBe(0);
    expect(screen.getByTestId('confirm-overwrite')).toBeInTheDocument();

    // Second Attach click — fires the API.
    fireEvent.click(screen.getByTestId('attach-submit'));
    await waitFor(() => expect(attachCalled).toBe(1), { timeout: 3000 });
  });

  it('calls discard API on confirm', async () => {
    const file = makeIngestFile({ id: UNMATCHED_FILE_ID, status: 'unmatched' });
    mswServer.use(unmatchedHandler([file]));

    let discardCalled = false;
    mswServer.use(
      http.post(
        `/api/v1/semesters/${DEFAULT_SEMESTER_ID}/unmatched/${UNMATCHED_FILE_ID}/discard`,
        () => {
          discardCalled = true;
          return HttpResponse.json({
            id: UNMATCHED_FILE_ID,
            original_filename: 'alice_hw1.zip',
            size_bytes: 1024,
            blob_sha256: 'abc',
            status: 'discarded',
          });
        },
      ),
    );

    renderUnmatchedView();

    await waitFor(
      () => expect(screen.getByTestId(`discard-btn-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`discard-btn-${UNMATCHED_FILE_ID}`));
    await waitFor(
      () => expect(screen.getByTestId(`discard-confirm-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`discard-confirm-${UNMATCHED_FILE_ID}`));

    await waitFor(() => expect(discardCalled).toBe(true), { timeout: 3000 });
  });
});
