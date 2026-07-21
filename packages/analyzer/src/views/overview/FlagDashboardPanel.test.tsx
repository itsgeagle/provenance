/**
 * FlagDashboardPanel tests.
 *
 * The panel is route-agnostic — it renders FlagViews and delegates navigation
 * to its caller — so these tests supply plain callbacks rather than a router
 * context, and assert the panel hands back the right supporting ref.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FlagDashboardPanel } from './FlagDashboardPanel.js';
import { toFlagViewFromLocal, type FlagView, type SupportingRef } from './flag-view.js';
import { fixtureFlags, makeMinimalIndex } from './test-fixtures.js';

function fixtureViews(): FlagView[] {
  const index = makeMinimalIndex();
  return fixtureFlags.map((f) => toFlagViewFromLocal(f, index));
}

function renderPanel(
  flags: FlagView[] = fixtureViews(),
  handlers: { onDrawerOpen?: () => void } = {},
) {
  const onJumpToTimeline = vi.fn<(ref: SupportingRef) => void>();
  const onJumpToReplay = vi.fn<(ref: SupportingRef) => void>();
  render(
    <FlagDashboardPanel
      flags={flags}
      onJumpToTimeline={onJumpToTimeline}
      onJumpToReplay={onJumpToReplay}
      onDrawerOpen={handlers.onDrawerOpen}
    />,
  );
  return { onJumpToTimeline, onJumpToReplay };
}

describe('FlagDashboardPanel', () => {
  it('renders the panel', () => {
    renderPanel();
    expect(screen.getByTestId('flag-dashboard-panel')).toBeInTheDocument();
  });

  it('renders all fixture flags', () => {
    renderPanel();
    expect(screen.getByTestId('flag-list')).toBeInTheDocument();
    // 3 flags in fixture
    expect(screen.getAllByTestId(/^flag-row-/)).toHaveLength(3);
  });

  it('shows flag titles', () => {
    renderPanel();
    expect(screen.getByText('Large paste detected')).toBeInTheDocument();
    expect(screen.getByText('External file modification')).toBeInTheDocument();
    expect(screen.getByText('Low typing, high output')).toBeInTheDocument();
  });

  it('severity chips show correct text', () => {
    renderPanel();
    const highChip = screen.getByTestId('severity-chip-high');
    expect(highChip.textContent).toBe('HIGH');

    const medChip = screen.getByTestId('severity-chip-medium');
    expect(medChip.textContent).toBe('MEDIUM');

    const lowChip = screen.getByTestId('severity-chip-low');
    expect(lowChip.textContent).toBe('LOW');
  });

  it('high severity chip has red classes', () => {
    renderPanel();
    const chip = screen.getByTestId('severity-chip-high');
    expect(chip.className).toContain('bg-red-100');
    expect(chip.className).toContain('text-red-700');
  });

  it('medium severity chip has amber classes', () => {
    renderPanel();
    const chip = screen.getByTestId('severity-chip-medium');
    expect(chip.className).toContain('bg-amber-100');
    expect(chip.className).toContain('text-amber-700');
  });

  it('low severity chip has blue classes', () => {
    renderPanel();
    const chip = screen.getByTestId('severity-chip-low');
    expect(chip.className).toContain('bg-blue-100');
    expect(chip.className).toContain('text-blue-700');
  });

  it('shows supporting event count', () => {
    renderPanel();
    // First flag has 2 supporting seqs
    expect(screen.getByTestId(`flag-row-${fixtureFlags[0]!.id}`).textContent).toContain('2 events');
    // Second flag has 1
    expect(screen.getByTestId(`flag-row-${fixtureFlags[1]!.id}`).textContent).toContain('1 event');
    // Third flag has 0
    expect(screen.getByTestId(`flag-row-${fixtureFlags[2]!.id}`).textContent).toContain('0 events');
  });

  it('renders no-flags message when flags is empty', () => {
    renderPanel([]);
    expect(screen.getByTestId('no-flags-message')).toBeInTheDocument();
    expect(screen.queryByTestId('flag-list')).not.toBeInTheDocument();
  });

  it('clicking a flag opens the drawer', () => {
    renderPanel();
    const flagRow = screen.getByTestId(`flag-row-${fixtureFlags[0]!.id}`);
    fireEvent.click(flagRow);
    // Drawer title should be visible (may appear multiple times: row + drawer title)
    expect(screen.getAllByText('Large paste detected').length).toBeGreaterThan(0);
    // The drawer severity badge
    expect(screen.getByTestId('drawer-severity')).toBeInTheDocument();
  });

  it('notifies the caller when a drawer opens, so it can load data lazily', () => {
    // The server Overview defers paging the whole event stream until this fires.
    const onDrawerOpen = vi.fn();
    renderPanel(fixtureViews(), { onDrawerOpen });
    expect(onDrawerOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`flag-row-${fixtureFlags[0]!.id}`));
    expect(onDrawerOpen).toHaveBeenCalled();
  });

  it('hands the caller the supporting ref that was clicked', () => {
    const { onJumpToTimeline } = renderPanel();
    fireEvent.click(screen.getByTestId(`flag-row-${fixtureFlags[0]!.id}`));
    fireEvent.click(screen.getByTestId('jump-btn-abc:2'));

    expect(onJumpToTimeline).toHaveBeenCalledTimes(1);
    expect(onJumpToTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc:2', timelineSeq: 'abc:2' }),
    );
  });
});
