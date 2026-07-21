/**
 * Tests for TransportBar's whole-bundle scrubbing and seam ticks.
 *
 * The transport spans the entire bundle now, so session boundaries need to be
 * visible on the scrub track — otherwise a multi-session submission looks like
 * one uninterrupted stretch of work.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransportBar } from './TransportBar.js';
import type { Seam } from './bundle-clock.js';
import type { ReplayState } from './engine-core.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

function ev(globalIdx: number, sessionId = 'sess-a'): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq: globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: null,
  };
}

function seamAt(atGlobalIdx: number, realGapMs: number): Seam {
  return {
    atGlobalIdx,
    prevSessionId: 'sess-a',
    nextSessionId: 'sess-b',
    realGapMs,
    collapsedGapMs: 5_000,
  };
}

function state(currentGlobalIdx: number): ReplayState {
  return {
    status: 'paused',
    currentGlobalIdx,
    speed: 1,
    sessionId: 'sess-a',
    virtualT: 0,
    skipIdle: false,
  };
}

function renderBar(opts: { events: IndexedEvent[]; seams?: Seam[]; current?: number }) {
  const onSeek = vi.fn();
  render(
    <TransportBar
      state={state(opts.current ?? 0)}
      events={opts.events}
      seams={opts.seams ?? []}
      onPlay={vi.fn()}
      onPause={vi.fn()}
      onStep={vi.fn()}
      onSeek={onSeek}
    />,
  );
  return { onSeek };
}

describe('TransportBar', () => {
  const events = Array.from({ length: 21 }, (_, i) => ev(i));

  it('renders one tick per session boundary', () => {
    renderBar({ events, seams: [seamAt(5, 60_000), seamAt(12, 60_000)] });
    expect(screen.getAllByTestId(/^seam-tick-/)).toHaveLength(2);
  });

  it('renders no ticks for a single-session bundle', () => {
    renderBar({ events });
    expect(screen.queryAllByTestId(/^seam-tick-/)).toHaveLength(0);
  });

  it('labels a tick with the real offline gap, not the collapsed playback gap', () => {
    // 4h 12m real, but playback only pauses for the 5s collapsed value. The UI
    // must show the real duration — the collapsed one would be misleading.
    renderBar({ events, seams: [seamAt(10, 15_120_000)] });
    expect(screen.getByTestId('seam-tick-10')).toHaveAttribute(
      'title',
      expect.stringContaining('4h 12m'),
    );
  });

  it('positions a tick proportionally along the track', () => {
    // 21 events → sliderMax 20; a seam at 10 sits at the midpoint.
    renderBar({ events, seams: [seamAt(10, 60_000)] });
    expect(screen.getByTestId('seam-tick-10')).toHaveStyle({ left: '50%' });
  });

  it('counts the whole bundle in the position label', () => {
    renderBar({ events, current: 10 });
    expect(screen.getByText('11 of 21')).toBeInTheDocument();
  });

  it('shows the em-dash label before the first event', () => {
    renderBar({ events, current: -1 });
    expect(screen.getByText('— of 21')).toBeInTheDocument();
  });

  it('does not render ticks when there is only one event', () => {
    // sliderMax === 0 would make the proportional position divide by zero.
    renderBar({ events: [ev(0)], seams: [seamAt(0, 60_000)] });
    expect(screen.queryAllByTestId(/^seam-tick-/)).toHaveLength(0);
  });
});
