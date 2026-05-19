/**
 * SummaryStatsPanel tests.
 *
 * Tests:
 * - Session count, assignment id, active/idle time rendered.
 * - File list rendered with file paths.
 * - Character activity numbers rendered.
 * - No-files case renders the empty message.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SummaryStatsPanel } from './SummaryStatsPanel.js';
import { makeMinimalBundle, makeMinimalIndex } from './test-fixtures.js';

function renderPanel(opts?: { emptyFiles?: boolean }) {
  const bundle = makeMinimalBundle();
  let index = makeMinimalIndex();

  if (opts?.emptyFiles) {
    index = { ...index, byFile: new Map(), ordered: [] } as typeof index;
  }

  render(
    <MemoryRouter>
      <SummaryStatsPanel index={index} bundle={bundle} />
    </MemoryRouter>,
  );
}

describe('SummaryStatsPanel', () => {
  it('renders the panel', () => {
    renderPanel();
    expect(screen.getByTestId('summary-stats-panel')).toBeInTheDocument();
  });

  it('shows session count', () => {
    renderPanel();
    // bundle has 1 session
    expect(screen.getByTestId('stat-sessions').textContent).toBe('1');
  });

  it('shows assignment id', () => {
    renderPanel();
    expect(screen.getByTestId('stat-assignment').textContent).toBe('hw1');
  });

  it('shows active time', () => {
    renderPanel();
    // ordered has 4 events spanning 30s total (3 x 10s gaps, all < 60s threshold)
    expect(screen.getByTestId('stat-active-time')).toBeInTheDocument();
    // "30s" of active time (three 10s gaps)
    expect(screen.getByTestId('stat-active-time').textContent).toBe('30s');
  });

  it('shows idle time (0s when all gaps are small)', () => {
    renderPanel();
    expect(screen.getByTestId('stat-idle-time').textContent).toBe('0s');
  });

  it('renders the file list with hw1.py', () => {
    renderPanel();
    expect(screen.getByTestId('file-list')).toBeInTheDocument();
    expect(screen.getByTestId('file-row-hw1.py')).toBeInTheDocument();
  });

  it('shows chars-added stat (typed + pasted)', () => {
    renderPanel();
    // charsTyped from 'hello' = 5, charsPasted from paste event = 300, total = 305
    const el = screen.getByTestId('stat-chars-added');
    expect(el.textContent).toBe('305');
  });

  it('renders no-files message when index has no files', () => {
    renderPanel({ emptyFiles: true });
    expect(screen.getByTestId('no-files-message')).toBeInTheDocument();
    expect(screen.queryByTestId('file-list')).not.toBeInTheDocument();
  });
});
