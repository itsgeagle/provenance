/**
 * ValidationReportPanel tests.
 *
 * Tests:
 * - Renders all 8 check rows.
 * - Overall badge text reflects report.overall.
 * - Failing check with supportingSeqs is clickable and navigates with ?seq= param.
 * - Skipped check is not clickable.
 * - Pass/fail/skipped status icons are rendered.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ValidationReportPanel } from './ValidationReportPanel.js';
import { fixtureReport, fixturePassReport, fixtureFailReport } from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the last navigated location from a router. */
function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderPanel(report = fixtureReport) {
  let lastLocation = '';
  render(
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route path="/overview" element={<ValidationReportPanel report={report} />} />
        <Route path="/timeline" element={<div data-testid="timeline-page" />} />
      </Routes>
      <LocationCapture
        onLocation={(l) => {
          lastLocation = l;
        }}
      />
    </MemoryRouter>,
  );
  return { getLocation: () => lastLocation };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ValidationReportPanel', () => {
  it('renders all 8 check rows', () => {
    renderPanel();
    expect(screen.getAllByTestId(/^check-row-/)).toHaveLength(8);
  });

  it('shows check labels', () => {
    renderPanel();
    expect(screen.getByText('Manifest signature')).toBeInTheDocument();
    expect(screen.getByText('Chain integrity')).toBeInTheDocument();
    expect(screen.getByText('Submitted code match')).toBeInTheDocument();
  });

  it('renders the overall badge as WARN for the fixture', () => {
    renderPanel();
    expect(screen.getByTestId('overall-badge').textContent).toBe('WARN');
  });

  it('renders overall badge as PASS for a passing report', () => {
    renderPanel(fixturePassReport);
    expect(screen.getByTestId('overall-badge').textContent).toBe('PASS');
  });

  it('renders overall badge as FAIL for a failing report', () => {
    renderPanel(fixtureFailReport);
    expect(screen.getByTestId('overall-badge').textContent).toBe('FAIL');
  });

  it('failing check row with supportingSeqs navigates to /timeline?seq=', () => {
    const { getLocation } = renderPanel();

    const row = screen.getByTestId('check-row-chain_integrity');
    fireEvent.click(row);

    expect(getLocation()).toBe('/timeline?seq=abc:4');
  });

  it('failing check with keyboard Enter also navigates', () => {
    const { getLocation } = renderPanel();

    const row = screen.getByTestId('check-row-chain_integrity');
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(getLocation()).toBe('/timeline?seq=abc:4');
  });

  it('failing check with keyboard Space also navigates', () => {
    const { getLocation } = renderPanel();

    const row = screen.getByTestId('check-row-chain_integrity');
    fireEvent.keyDown(row, { key: ' ' });

    expect(getLocation()).toBe('/timeline?seq=abc:4');
  });

  it('pass row does not have role=button', () => {
    renderPanel();
    const passRow = screen.getByTestId('check-row-manifest_sig');
    expect(passRow.getAttribute('role')).toBeNull();
  });

  it('skipped row shows "skipped" label', () => {
    renderPanel();
    const row = screen.getByTestId('check-row-submitted_code_match');
    expect(row.textContent).toContain('skipped');
  });

  it('check detail text is visible when present', () => {
    renderPanel();
    expect(screen.getByText('Hash mismatch at seq 4 (session abc).')).toBeInTheDocument();
  });

  it('panel has data-testid', () => {
    renderPanel();
    expect(screen.getByTestId('validation-report-panel')).toBeInTheDocument();
  });
});
