/**
 * Actions tests.
 *
 * Tests:
 * - "Open Raw Timeline" button navigates to /timeline.
 * - "Export Findings (Markdown)" button is present.
 * - Export button is disabled when no bundle is loaded.
 *
 * Export-button click behavior (download trigger) is covered separately
 * in ExportMarkdownButton.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Actions } from './Actions.js';
import { BundleProvider } from '../../context/BundleContext.js';

function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderActions() {
  let lastLocation = '';
  render(
    <MemoryRouter initialEntries={['/overview']}>
      <BundleProvider>
        <Routes>
          <Route path="/overview" element={<Actions />} />
          <Route path="/timeline" element={<div data-testid="timeline-page" />} />
        </Routes>
        <LocationCapture
          onLocation={(l) => {
            lastLocation = l;
          }}
        />
      </BundleProvider>
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

  it('Export Findings (Markdown) button is disabled when no bundle is loaded', () => {
    renderActions();
    const btn = screen.getByTestId('btn-export-findings');
    expect(btn).toBeDisabled();
  });
});
