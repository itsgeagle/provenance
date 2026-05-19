/**
 * Actions tests.
 *
 * Tests:
 * - "Open Raw Timeline" button navigates to /timeline.
 * - "Export Findings (Markdown)" button is present but disabled.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Actions } from './Actions.js';

function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderActions() {
  let lastLocation = '';
  render(
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route path="/overview" element={<Actions />} />
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

describe('Actions', () => {
  it('renders the actions bar', () => {
    renderActions();
    expect(screen.getByTestId('overview-actions')).toBeInTheDocument();
  });

  it('Open Raw Timeline button is present', () => {
    renderActions();
    expect(screen.getByTestId('btn-open-timeline')).toBeInTheDocument();
  });

  it('clicking Open Raw Timeline navigates to /timeline', () => {
    const { getLocation } = renderActions();
    fireEvent.click(screen.getByTestId('btn-open-timeline'));
    expect(getLocation()).toBe('/timeline');
  });

  it('Export Findings (Markdown) button is present', () => {
    renderActions();
    expect(screen.getByTestId('btn-export-findings')).toBeInTheDocument();
  });

  it('Export Findings (Markdown) button is disabled', () => {
    renderActions();
    const btn = screen.getByTestId('btn-export-findings');
    expect(btn).toBeDisabled();
  });

  it('Export button has a tooltip hinting at Phase 8', () => {
    renderActions();
    const btn = screen.getByTestId('btn-export-findings');
    expect(btn.getAttribute('title')).toContain('Phase 8');
  });
});
