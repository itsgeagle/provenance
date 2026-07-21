/**
 * SessionSelect.test.tsx
 *
 * The control is a LIVE READOUT of the playhead's session plus a seek target.
 * These tests pin both halves: the value must follow `currentSessionId` (which
 * the engine derives from the playhead), and changing it must hand the parent a
 * globalIdx to seek to — never a route to navigate to.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionSelect } from './SessionSelect.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

function makeEvent(globalIdx: number, sessionId: string, wall: string): IndexedEvent {
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall,
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: {},
    file: 'hw.py',
  };
}

function buildIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered = [...events].sort((a, b) => a.globalIdx - b.globalIdx);
  for (const e of ordered) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);
    const kl = byKind.get(e.kind) ?? [];
    kl.push(e);
    byKind.set(e.kind, kl);
    if (e.file) {
      const fl = byFile.get(e.file) ?? [];
      fl.push(e);
      byFile.set(e.file, fl);
    }
    const sl = bySessionId.get(e.sessionId) ?? [];
    sl.push(e);
    bySessionId.set(e.sessionId, sl);
  }
  return { bySeq, byKind, byFile, bySessionId, ordered };
}

/** Two sessions: sess1 owns globalIdx 0-1, sess2 owns 2-4. */
function twoSessionIndex(): EventIndex {
  return buildIndex([
    makeEvent(0, 'sess1', '2026-01-01T10:00:00.000Z'),
    makeEvent(1, 'sess1', '2026-01-01T10:05:00.000Z'),
    makeEvent(2, 'sess2', '2026-01-02T14:00:00.000Z'),
    makeEvent(3, 'sess2', '2026-01-02T14:01:00.000Z'),
    makeEvent(4, 'sess2', '2026-01-02T14:02:00.000Z'),
  ]);
}

describe('SessionSelect', () => {
  describe('when there is nothing to choose between', () => {
    it('renders nothing for a single-session bundle', () => {
      const index = buildIndex([makeEvent(0, 'sess1', '2026-01-01T10:00:00.000Z')]);
      const { container } = render(
        <SessionSelect index={index} currentSessionId="sess1" onSeek={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('replay-session-switcher')).toBeNull();
    });

    it('renders nothing for an empty index', () => {
      const { container } = render(
        <SessionSelect index={buildIndex([])} currentSessionId="" onSeek={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('option labels', () => {
    it('gives each session an ordinal, a start time, and an event count', () => {
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess1" onSeek={vi.fn()} />);
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(2);

      expect(options[0]!.textContent).toContain('Session 1 of 2');
      expect(options[0]!.textContent).toContain('2 events');
      expect(options[0]!.textContent).toContain(
        new Date('2026-01-01T10:00:00.000Z').toLocaleString(),
      );

      expect(options[1]!.textContent).toContain('Session 2 of 2');
      expect(options[1]!.textContent).toContain('3 events');
    });

    it('says "1 event" rather than "1 events"', () => {
      const index = buildIndex([
        makeEvent(0, 'sess1', '2026-01-01T10:00:00.000Z'),
        makeEvent(1, 'sess2', '2026-01-02T10:00:00.000Z'),
      ]);
      render(<SessionSelect index={index} currentSessionId="sess1" onSeek={vi.fn()} />);
      expect(screen.getAllByRole('option')[0]!.textContent).toContain('1 event');
      expect(screen.getAllByRole('option')[0]!.textContent).not.toContain('1 events');
    });

    it('omits the timestamp when the session start wall is unparseable', () => {
      const index = buildIndex([
        makeEvent(0, 'sess1', 'not-a-date'),
        makeEvent(1, 'sess2', '2026-01-02T10:00:00.000Z'),
      ]);
      render(<SessionSelect index={index} currentSessionId="sess1" onSeek={vi.fn()} />);
      const first = screen.getAllByRole('option')[0]!;
      expect(first.textContent).toContain('Session 1 of 2');
      expect(first.textContent).toContain('1 event');
      expect(first.textContent).not.toContain('Invalid Date');
    });
  });

  describe('as a readout of the playhead', () => {
    it('selects the session the playhead is in, not the first one', () => {
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess2" onSeek={vi.fn()} />);
      expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
        'sess2',
      );
      expect(screen.getByTestId('replay-session-ordinal').textContent).toBe('2 / 2');
    });

    it('follows currentSessionId when the playhead crosses a seam', () => {
      const index = twoSessionIndex();
      const { rerender } = render(
        <SessionSelect index={index} currentSessionId="sess1" onSeek={vi.fn()} />,
      );
      expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
        'sess1',
      );

      rerender(<SessionSelect index={index} currentSessionId="sess2" onSeek={vi.fn()} />);
      expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
        'sess2',
      );
      expect(screen.getByTestId('replay-session-ordinal').textContent).toBe('2 / 2');
    });

    it('omits the ordinal rather than showing 0 / N for an unknown session', () => {
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="ghost" onSeek={vi.fn()} />);
      expect(screen.queryByTestId('replay-session-ordinal')).toBeNull();
    });
  });

  describe('as a seek control', () => {
    it('seeks to the target session’s FIRST globalIdx', () => {
      const onSeek = vi.fn();
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess1" onSeek={onSeek} />);
      fireEvent.change(screen.getByTestId('replay-session-select'), {
        target: { value: 'sess2' },
      });
      expect(onSeek).toHaveBeenCalledTimes(1);
      expect(onSeek).toHaveBeenCalledWith(2);
    });

    it('seeks backwards too', () => {
      const onSeek = vi.fn();
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess2" onSeek={onSeek} />);
      fireEvent.change(screen.getByTestId('replay-session-select'), {
        target: { value: 'sess1' },
      });
      expect(onSeek).toHaveBeenCalledWith(0);
    });
  });

  describe('accessibility', () => {
    it('labels the select', () => {
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess1" onSeek={vi.fn()} />);
      expect(screen.getByLabelText('Session')).toBe(screen.getByTestId('replay-session-select'));
    });

    it('hides the ordinal from assistive tech, since the option text already says it', () => {
      render(<SessionSelect index={twoSessionIndex()} currentSessionId="sess1" onSeek={vi.fn()} />);
      expect(screen.getByTestId('replay-session-ordinal')).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
