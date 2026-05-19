/**
 * Tests for EventDetail.
 *
 * - Renders placeholder when no event selected.
 * - Renders event metadata and JSON.
 * - Surrounding event navigation calls onNavigate.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventDetail } from './EventDetail.js';
import type { IndexedEvent } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<IndexedEvent>): IndexedEvent {
  return {
    sessionId: 'session-abc',
    seq: 5,
    globalIdx: 5,
    wall: '2026-01-01T00:01:30.000Z',
    t: 90000,
    kind: 'paste',
    payload: { path: 'hw1.py', length: 300, sha256: 'abc' },
    file: 'hw1.py',
    ...overrides,
  };
}

function makeAllEvents(target: IndexedEvent): IndexedEvent[] {
  const prev = makeEvent({ globalIdx: 4, seq: 4, kind: 'doc.change' });
  const next = makeEvent({ globalIdx: 6, seq: 6, kind: 'doc.save' });
  // Build a 7-element list; target is at index 5
  return [
    makeEvent({ globalIdx: 0, seq: 0, kind: 'session.start' }),
    makeEvent({ globalIdx: 1, seq: 1, kind: 'doc.open' }),
    makeEvent({ globalIdx: 2, seq: 2, kind: 'doc.change' }),
    makeEvent({ globalIdx: 3, seq: 3, kind: 'doc.change' }),
    prev,
    target,
    next,
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventDetail', () => {
  it('renders placeholder when no event selected', () => {
    render(<EventDetail event={null} allEvents={[]} onNavigate={vi.fn()} />);
    expect(screen.getByTestId('event-detail-placeholder')).toBeInTheDocument();
    expect(screen.getByText('Select an event from the list to see details.')).toBeInTheDocument();
  });

  it('renders event metadata', () => {
    const event = makeEvent({});
    const allEvents = makeAllEvents(event);
    render(<EventDetail event={event} allEvents={allEvents} onNavigate={vi.fn()} />);

    expect(screen.getByTestId('detail-kind')).toHaveTextContent('paste');
    expect(screen.getByTestId('detail-seq')).toHaveTextContent('#5');
    expect(screen.getByTestId('detail-global-idx')).toHaveTextContent('5');
    expect(screen.getByTestId('detail-t')).toHaveTextContent('90000');
    expect(screen.getByTestId('detail-session-id')).toHaveTextContent('session-abc');
    expect(screen.getByTestId('detail-file')).toHaveTextContent('hw1.py');
  });

  it('renders pretty-printed JSON payload', () => {
    const event = makeEvent({
      payload: { path: 'hw1.py', length: 300, sha256: 'abc' },
    });
    const allEvents = makeAllEvents(event);
    render(<EventDetail event={event} allEvents={allEvents} onNavigate={vi.fn()} />);

    const pre = screen.getByTestId('event-json');
    const text = pre.textContent ?? '';
    // Should contain JSON keys from the payload
    expect(text).toContain('"path"');
    expect(text).toContain('"length"');
    expect(text).toContain('300');
  });

  it('shows surrounding events (previous and next)', () => {
    const event = makeEvent({});
    const allEvents = makeAllEvents(event);
    render(<EventDetail event={event} allEvents={allEvents} onNavigate={vi.fn()} />);

    // Previous and next navigation buttons
    expect(screen.getByTestId('navigate-to-4')).toBeInTheDocument();
    expect(screen.getByTestId('navigate-to-6')).toBeInTheDocument();
  });

  it('calls onNavigate when previous event is clicked', () => {
    const onNavigate = vi.fn();
    const event = makeEvent({});
    const allEvents = makeAllEvents(event);
    render(<EventDetail event={event} allEvents={allEvents} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId('navigate-to-4'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(allEvents[4]);
  });

  it('calls onNavigate when next event is clicked', () => {
    const onNavigate = vi.fn();
    const event = makeEvent({});
    const allEvents = makeAllEvents(event);
    render(<EventDetail event={event} allEvents={allEvents} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId('navigate-to-6'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(allEvents[6]);
  });

  it('does not show previous button for first event', () => {
    const firstEvent = makeEvent({ globalIdx: 0, seq: 0 });
    const allEvents = [firstEvent, makeEvent({ globalIdx: 1, seq: 1, kind: 'doc.change' })];
    render(<EventDetail event={firstEvent} allEvents={allEvents} onNavigate={vi.fn()} />);
    expect(screen.queryByTestId('navigate-to--1')).not.toBeInTheDocument();
    expect(screen.queryByText('Previous')).not.toBeInTheDocument();
  });

  it('does not show next button for last event', () => {
    const lastEvent = makeEvent({ globalIdx: 1, seq: 1, kind: 'doc.change' });
    const allEvents = [makeEvent({ globalIdx: 0, seq: 0, kind: 'session.start' }), lastEvent];
    render(<EventDetail event={lastEvent} allEvents={allEvents} onNavigate={vi.fn()} />);
    expect(screen.queryByText('Next')).not.toBeInTheDocument();
  });

  it('does not render file row when event has no file', () => {
    const event: IndexedEvent = {
      sessionId: 'session-abc',
      seq: 0,
      globalIdx: 0,
      wall: '2026-01-01T00:00:00.000Z',
      t: 0,
      kind: 'session.start',
      payload: {},
    };
    render(<EventDetail event={event} allEvents={[event]} onNavigate={vi.fn()} />);
    expect(screen.queryByTestId('detail-file')).not.toBeInTheDocument();
  });
});
