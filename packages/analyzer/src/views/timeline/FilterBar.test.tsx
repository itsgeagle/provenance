/**
 * Tests for FilterBar.
 *
 * - Kind selection updates filters.
 * - Clear-all resets to DEFAULT_FILTERS.
 * - Session dropdown hidden when ≤1 session.
 * - Time range inputs parse values.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar } from './FilterBar.js';
import { DEFAULT_FILTERS, type TimelineFilters } from './useFilteredEvents.js';

const AVAILABLE_KINDS = ['doc.change', 'paste', 'doc.save', 'session.start'] as const;
const AVAILABLE_FILES = ['hw1.py', 'hw2.py'];
const AVAILABLE_SESSIONS = ['session-abc', 'session-def'];

function renderBar({
  filters = DEFAULT_FILTERS,
  onChange = vi.fn(),
  availableKinds = [...AVAILABLE_KINDS],
  availableFiles = AVAILABLE_FILES,
  availableSessions = AVAILABLE_SESSIONS,
}: {
  filters?: TimelineFilters;
  onChange?: (f: TimelineFilters) => void;
  availableKinds?: string[];
  availableFiles?: string[];
  availableSessions?: string[];
} = {}) {
  return render(
    <FilterBar
      filters={filters}
      onChange={onChange}
      availableKinds={availableKinds as never}
      availableFiles={availableFiles}
      availableSessions={availableSessions}
    />,
  );
}

describe('FilterBar', () => {
  it('renders the filter bar', () => {
    renderBar();
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
  });

  it('renders kind filter trigger button', () => {
    renderBar();
    expect(screen.getByTestId('kind-filter-trigger')).toBeInTheDocument();
  });

  it('renders file filter trigger button', () => {
    renderBar();
    expect(screen.getByTestId('file-filter-trigger')).toBeInTheDocument();
  });

  it('renders session filter when multiple sessions', () => {
    renderBar({ availableSessions: ['sess-1', 'sess-2'] });
    expect(screen.getByTestId('session-filter-trigger')).toBeInTheDocument();
  });

  it('hides session filter when only one session', () => {
    renderBar({ availableSessions: ['sess-1'] });
    expect(screen.queryByTestId('session-filter-trigger')).not.toBeInTheDocument();
  });

  it('hides session filter when no sessions', () => {
    renderBar({ availableSessions: [] });
    expect(screen.queryByTestId('session-filter-trigger')).not.toBeInTheDocument();
  });

  it('renders time range inputs', () => {
    renderBar();
    expect(screen.getByTestId('time-start-input')).toBeInTheDocument();
    expect(screen.getByTestId('time-end-input')).toBeInTheDocument();
  });

  it('does not show clear-all when no filters active', () => {
    renderBar({ filters: DEFAULT_FILTERS });
    expect(screen.queryByTestId('clear-filters-btn')).not.toBeInTheDocument();
  });

  it('shows clear-all when kind filter is active', () => {
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      kinds: new Set(['paste'] as never),
    };
    renderBar({ filters });
    expect(screen.getByTestId('clear-filters-btn')).toBeInTheDocument();
  });

  it('shows kind chip for active kind filters', () => {
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      kinds: new Set(['paste', 'doc.save'] as never),
    };
    renderBar({ filters });
    expect(screen.getByTestId('kind-chip-paste')).toBeInTheDocument();
    expect(screen.getByTestId('kind-chip-doc.save')).toBeInTheDocument();
  });

  it('clicking clear-all calls onChange with DEFAULT_FILTERS', () => {
    const onChange = vi.fn();
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      kinds: new Set(['paste'] as never),
    };
    renderBar({ filters, onChange });
    fireEvent.click(screen.getByTestId('clear-filters-btn'));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });

  it('removing a kind chip calls onChange with kind removed', () => {
    const onChange = vi.fn();
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      kinds: new Set(['paste', 'doc.save'] as never),
    };
    renderBar({ filters, onChange });
    fireEvent.click(screen.getByTestId('kind-chip-remove-paste'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const newFilters = onChange.mock.calls[0]![0] as TimelineFilters;
    expect(newFilters.kinds.has('paste' as never)).toBe(false);
    expect(newFilters.kinds.has('doc.save' as never)).toBe(true);
  });

  it('time start input updates timeRangeMs.start', () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.change(screen.getByTestId('time-start-input'), { target: { value: '1000' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const newFilters = onChange.mock.calls[0]![0] as TimelineFilters;
    expect(newFilters.timeRangeMs.start).toBe(1000);
  });

  it('time end input updates timeRangeMs.end', () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.change(screen.getByTestId('time-end-input'), { target: { value: '5000' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const newFilters = onChange.mock.calls[0]![0] as TimelineFilters;
    expect(newFilters.timeRangeMs.end).toBe(5000);
  });

  it('clearing time start input sets start to null', () => {
    const onChange = vi.fn();
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      timeRangeMs: { start: 1000, end: null },
    };
    renderBar({ filters, onChange });
    fireEvent.change(screen.getByTestId('time-start-input'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const newFilters = onChange.mock.calls[0]![0] as TimelineFilters;
    expect(newFilters.timeRangeMs.start).toBeNull();
  });

  it('shows clear-all when time range is active', () => {
    const filters: TimelineFilters = {
      ...DEFAULT_FILTERS,
      timeRangeMs: { start: 100, end: null },
    };
    renderBar({ filters });
    expect(screen.getByTestId('clear-filters-btn')).toBeInTheDocument();
  });

  it('file filter not rendered when no files available', () => {
    renderBar({ availableFiles: [] });
    expect(screen.queryByTestId('file-filter-trigger')).not.toBeInTheDocument();
  });
});
