/**
 * FlagDashboardPanel tests.
 *
 * Tests:
 * - Renders all fixture flags in order.
 * - Severity chips show the right text.
 * - Severity chip classes match severity-color mapping.
 * - Supporting event count is displayed.
 * - Empty flags renders the no-flags message.
 * - Clicking a flag opens the HeuristicDetailDrawer (content appears in DOM).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FlagDashboardPanel } from './FlagDashboardPanel.js';
import { fixtureFlags, makeMinimalIndex } from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock BundleContext — HeuristicDetailDrawer (rendered inside the panel when
// a flag row is clicked) calls useBundle() to resolve globalIdx for replay links.
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

function renderPanel(flags = fixtureFlags) {
  render(
    <MemoryRouter>
      <FlagDashboardPanel flags={flags} />
    </MemoryRouter>,
  );
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
});
