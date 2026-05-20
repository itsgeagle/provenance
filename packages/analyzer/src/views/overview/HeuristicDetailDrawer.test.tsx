/**
 * HeuristicDetailDrawer tests.
 *
 * Tests:
 * - Renders trigger but not drawer content before opening.
 * - Click trigger opens the drawer (flag title, severity, description visible).
 * - Supporting event rows rendered; jump buttons navigate to /timeline?seq=.
 * - Detail JSON rendered when flag has detail.
 * - Flags with no supportingSeqs show no supporting-events section.
 * - Flags with no detail show no detail-json section.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { HeuristicDetailDrawer } from './HeuristicDetailDrawer.js';
import { fixtureFlags, makeMinimalIndex } from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock BundleContext — DrawerBody calls useBundle() to resolve globalIdx for
// the "▶ Replay" deep-link. We supply a minimal index so the replay buttons
// render correctly (disabled when seqKey not in index).
// ---------------------------------------------------------------------------

vi.mock('../../context/BundleContext.js', () => ({
  useBundle: () => ({
    index: makeMinimalIndex(),
    flags: fixtureFlags,
    bundles: [],
    selectedBundleId: null,
    selectBundle: vi.fn(),
    indicesByBundle: new Map(),
    validationReportByBundle: new Map(),
    flagsByBundle: new Map(),
    validationReport: null,
    status: 'loaded' as const,
    loadingStage: null,
    loadError: null,
    partialLoadErrors: [],
    loadBundleFile: vi.fn(),
    loadBundleFiles: vi.fn(),
    clearBundle: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderDrawer(flagIndex = 0) {
  const flag = fixtureFlags[flagIndex]!;
  let lastLocation = '';

  render(
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route
          path="/overview"
          element={
            <HeuristicDetailDrawer flag={flag}>
              <button data-testid="open-btn">Open</button>
            </HeuristicDetailDrawer>
          }
        />
        <Route path="/timeline" element={<div data-testid="timeline-page" />} />
        <Route path="/replay/:sessionId" element={<div data-testid="replay-page" />} />
      </Routes>
      <LocationCapture
        onLocation={(l) => {
          lastLocation = l;
        }}
      />
    </MemoryRouter>,
  );

  return { flag, getLocation: () => lastLocation };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeuristicDetailDrawer', () => {
  it('renders the trigger without opening the drawer', () => {
    renderDrawer();
    expect(screen.getByTestId('open-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('heuristic-drawer')).not.toBeInTheDocument();
  });

  it('clicking trigger opens the drawer with flag title', () => {
    const { flag } = renderDrawer();
    fireEvent.click(screen.getByTestId('open-btn'));
    // Flag title appears in the drawer header
    expect(screen.getAllByText(flag.title).length).toBeGreaterThan(0);
  });

  it('drawer shows severity chip', () => {
    renderDrawer(0); // high severity
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.getByTestId('drawer-severity').textContent).toBe('HIGH');
  });

  it('drawer shows flag description', () => {
    const { flag } = renderDrawer();
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.getByText(flag.description)).toBeInTheDocument();
  });

  it('supporting event rows are rendered for flag 0', () => {
    renderDrawer(0); // 2 supporting seqs: abc:2, abc:3
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.getByTestId('supporting-events-list')).toBeInTheDocument();
    expect(screen.getByTestId('jump-btn-abc:2')).toBeInTheDocument();
    expect(screen.getByTestId('jump-btn-abc:3')).toBeInTheDocument();
  });

  it('jump button navigates to /timeline?seq=', () => {
    const { getLocation } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-btn-abc:2'));
    expect(getLocation()).toBe('/timeline?seq=abc:2');
  });

  it('second jump button navigates with correct seq', () => {
    const { getLocation } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-btn-abc:3'));
    expect(getLocation()).toBe('/timeline?seq=abc:3');
  });

  it('detail JSON is rendered when flag has detail', () => {
    renderDrawer(0); // flag 0 has detail: { pastedChars: 5000, file: 'hw1.py' }
    fireEvent.click(screen.getByTestId('open-btn'));
    const detailEl = screen.getByTestId('detail-json');
    expect(detailEl.textContent).toContain('5000');
    expect(detailEl.textContent).toContain('hw1.py');
  });

  it('no supporting-events section when flag has no supportingSeqs', () => {
    renderDrawer(2); // flag 2 has supportingSeqs: []
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.queryByTestId('supporting-events-list')).not.toBeInTheDocument();
  });

  it('no detail-json section when flag has no detail', () => {
    renderDrawer(2); // flag 2 has no detail field
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.queryByTestId('detail-json')).not.toBeInTheDocument();
  });

  it('medium severity drawer shows amber chip', () => {
    renderDrawer(1); // medium severity
    fireEvent.click(screen.getByTestId('open-btn'));
    const chip = screen.getByTestId('drawer-severity');
    expect(chip.textContent).toBe('MEDIUM');
    expect(chip.className).toContain('bg-amber-100');
  });

  it('replay button is enabled when globalIdx resolves from index.bySeq', () => {
    // Flag 0 has supportingSeqs: ['abc:2', 'abc:3']
    // makeMinimalIndex now populates bySeq with these keys (Phase 15 fix)
    renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    const replayBtn = screen.getByTestId('jump-replay-btn-abc:2');
    expect(replayBtn).not.toBeDisabled();
  });

  it('replay button navigates to /replay/:sessionId?event=:globalIdx', () => {
    // Flag 0: supporting seq abc:2 → globalIdx 2 (from makeMinimalIndex bySeq)
    const { getLocation } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-replay-btn-abc:2'));
    expect(getLocation()).toBe('/replay/abc?event=2');
  });
});
