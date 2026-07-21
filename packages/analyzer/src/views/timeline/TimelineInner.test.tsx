/**
 * Tests for TimelineInner — the route-agnostic events browser.
 *
 * The point of this component is that it works against ANY EventIndex, whether
 * built in-browser from a .zip (/local) or paged from the server API (the
 * submission Timeline tab). These tests build the index the server way, via
 * buildIndexFromEventRows, so they cover the path the server tab uses.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TimelineInner } from './TimelineInner.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two sessions: `sess-a` (3 events) then `sess-b` (2 events), four hours later.
 * hw1.py is touched only in session a; hw2.py only in session b.
 */
function twoSessionRows(): ServerEventRow[] {
  return [
    {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      session_id: 'sess-a',
      payload: { session_id: 'sess-a' },
    },
    {
      seq: 1,
      kind: 'doc.change',
      t: 100,
      wall: '2026-01-01T00:00:00.100Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py', deltas: [] },
    },
    {
      seq: 2,
      kind: 'doc.save',
      t: 200,
      wall: '2026-01-01T00:00:00.200Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T04:00:00.000Z',
      session_id: 'sess-b',
      payload: { session_id: 'sess-b' },
    },
    {
      seq: 1,
      kind: 'doc.change',
      t: 50,
      wall: '2026-01-01T04:00:00.050Z',
      session_id: 'sess-b',
      payload: { path: 'hw2.py', deltas: [] },
    },
  ];
}

function renderInner(
  rows: ServerEventRow[] | null,
  onJumpToReplay?: (event: IndexedEvent) => void,
  initialEntries: string[] = ['/'],
) {
  const index = rows === null ? null : buildIndexFromEventRows(rows);
  return {
    index,
    ...render(
      <MemoryRouter initialEntries={initialEntries}>
        <div style={{ height: '600px', width: '800px' }}>
          <TimelineInner index={index} onJumpToReplay={onJumpToReplay} />
        </div>
      </MemoryRouter>,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimelineInner', () => {
  it('counts every event across all sessions', () => {
    renderInner(twoSessionRows());
    expect(screen.getByTestId('event-count-label')).toHaveTextContent('5 events');
  });

  it('renders rows for events from both sessions', () => {
    renderInner(twoSessionRows());
    const rows = screen.getAllByTestId(/^event-row-/);
    expect(rows.length).toBe(5);
  });

  it('renders events from both sessions, not just the first', () => {
    // The session chip on each row carries sessionId.slice(0, 6). Asserting both
    // appear proves the list spans sessions. (The session *filter* dropdown is a
    // Radix menu that only mounts its options once opened, which needs real
    // pointer events; its contents are Radix's behavior, not this component's.)
    renderInner(twoSessionRows());
    const chips = screen.getAllByTestId(/^session-chip-/).map((el) => el.textContent);
    expect(new Set(chips)).toEqual(new Set(['sess-a', 'sess-b']));
  });

  it('invokes onJumpToReplay with the clicked event', () => {
    const onJumpToReplay = vi.fn();
    const { index } = renderInner(twoSessionRows(), onJumpToReplay);

    fireEvent.click(screen.getByTestId('replay-btn-0'));

    expect(onJumpToReplay).toHaveBeenCalledTimes(1);
    expect(onJumpToReplay).toHaveBeenCalledWith(index!.ordered[0]);
  });

  it('omits the replay button when no callback is supplied', () => {
    renderInner(twoSessionRows());
    expect(screen.queryByTestId('replay-btn-0')).toBeNull();
  });

  it('renders an empty timeline when the index is null', () => {
    renderInner(null);
    expect(screen.getByTestId('event-count-label')).toHaveTextContent('0 events');
  });

  it('selects the deep-linked event from ?seq=sessionId:seq', () => {
    renderInner(twoSessionRows(), undefined, ['/?seq=sess-b:1']);
    // EventDetail shows the selected event's session id.
    expect(screen.getByTestId('detail-session-id')).toHaveTextContent('sess-b');
  });
});
