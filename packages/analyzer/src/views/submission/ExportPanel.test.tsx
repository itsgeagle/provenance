/**
 * ExportPanel tests — V46 stub.
 *
 * The full export panel was reverted to a v3.1 stub once it became clear
 * that the POST /submissions/:id/export endpoint had never landed. These
 * tests now just verify the stub renders without polling, mutation hooks,
 * or 404-prone affordances.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ExportPanel } from './ExportPanel.js';

const SUBMISSION_ID = 'ssss0000-0000-0000-0000-000000000001';

function renderExportPanel() {
  return render(
    <MemoryRouter initialEntries={[`/s/cs61a/sp25/sub/${SUBMISSION_ID}?tab=export`]}>
      <Routes>
        <Route path="/s/:courseSlug/:semesterSlug/sub/:submissionId" element={<ExportPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExportPanel (v3.1 stub)', () => {
  it('renders the panel container', () => {
    renderExportPanel();
    expect(screen.getByTestId('export-panel')).toBeInTheDocument();
  });

  it('mentions v3.1 so users know the affordance is coming back', () => {
    renderExportPanel();
    expect(screen.getByText(/v3\.1/)).toBeInTheDocument();
  });

  it('does not render a generate-export button (no 404-prone affordance)', () => {
    renderExportPanel();
    expect(screen.queryByTestId('generate-export-btn')).toBeNull();
    expect(screen.queryByTestId('format-pdf')).toBeNull();
    expect(screen.queryByTestId('format-markdown')).toBeNull();
  });
});
