/**
 * EventSidebar.test.tsx
 *
 * Tests:
 *  1. Renders the sidebar header.
 *  2. Renders a row for each event.
 *  3. The current event row has aria-current="step".
 *  4. Clicking a row calls onSeek with the event's globalIdx.
 *  5. Empty events → shows "No events" state.
 *  6. Auto-scroll: virtualizer.scrollToIndex is called when currentGlobalIdx changes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EventSidebar } from './EventSidebar.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(globalIdx: number, kind: IndexedEvent['kind'] = 'doc.change'): IndexedEvent {
  const base = {
    sessionId: 'sess1',
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload: null,
  } as IndexedEvent;
  if (globalIdx % 2 === 0) {
    base.file = 'hw.py';
  }
  return base;
}

const THREE_EVENTS: IndexedEvent[] = [
  makeEvent(0, 'session.start'),
  makeEvent(1, 'doc.change'),
  makeEvent(2, 'paste'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventSidebar', () => {
  it('renders the "Events" header', () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByTestId('event-sidebar')).toBeDefined();
    expect(screen.getByText('Events')).toBeDefined();
  });

  it('shows "No events" when events array is empty', () => {
    render(<EventSidebar events={[]} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByText('No events')).toBeDefined();
  });

  it('renders a virtual container when events are present', () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByTestId('sidebar-virtual-container')).toBeDefined();
  });

  it('marks the current event row with aria-current="step"', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const currentRow = screen.getByTestId('sidebar-row-1');
      expect(currentRow.getAttribute('aria-current')).toBe('step');
    });
  });

  it('other rows do not have aria-current', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const row0 = screen.getByTestId('sidebar-row-0');
      expect(row0.getAttribute('aria-current')).toBeNull();
    });
  });

  it('calls onSeek with the event globalIdx when a row is clicked', async () => {
    const onSeek = vi.fn();
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={onSeek} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-2');
      fireEvent.click(row);
      expect(onSeek).toHaveBeenCalledWith(2);
    });
  });

  it('keyboard Enter on a row calls onSeek', async () => {
    const onSeek = vi.fn();
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={onSeek} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-0');
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(onSeek).toHaveBeenCalledWith(0);
    });
  });

  describe('auto-scroll on currentGlobalIdx change', () => {
    it('does not throw when currentGlobalIdx advances', async () => {
      // The virtualizer.scrollToIndex call is exercised; we just assert no throw.
      const { rerender } = render(
        <EventSidebar events={THREE_EVENTS} currentGlobalIdx={0} onSeek={vi.fn()} />,
      );
      // Advance to event 2.
      rerender(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={2} onSeek={vi.fn()} />);
      // No throw; aria-current updates.
      await waitFor(() => {
        expect(screen.getByTestId('sidebar-row-2').getAttribute('aria-current')).toBe('step');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// ColorLegend smoke test (co-located for brevity)
// ---------------------------------------------------------------------------

import { ColorLegend } from './ColorLegend.js';

describe('ColorLegend', () => {
  it('renders all three legend items', () => {
    render(<ColorLegend />);
    const legend = screen.getByTestId('color-legend');
    expect(legend).toBeDefined();
    expect(legend.textContent).toContain('Paste');
    expect(legend.textContent).toContain('External');
    expect(legend.textContent).toContain('Uncolored: typed');
  });
});
