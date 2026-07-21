/**
 * HeuristicDetailDrawer tests.
 *
 * The drawer is route-agnostic: it renders a FlagView and calls back rather
 * than navigating, so these assert on the refs it hands out. Route-specific
 * URL shapes are covered where the callbacks are supplied — OverviewView.test
 * for /local, Overview.test for the submission tab.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeuristicDetailDrawer } from './HeuristicDetailDrawer.js';
import { toFlagViewFromLocal, type FlagView, type SupportingRef } from './flag-view.js';
import { fixtureFlags, makeMinimalIndex } from './test-fixtures.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDrawer(
  flagIndex = 0,
  opts: { flag?: FlagView; sessionOrdinals?: Map<string, number> } = {},
) {
  const flag = opts.flag ?? toFlagViewFromLocal(fixtureFlags[flagIndex]!, makeMinimalIndex());
  const onJumpToTimeline = vi.fn<(ref: SupportingRef) => void>();
  const onJumpToReplay = vi.fn<(ref: SupportingRef) => void>();

  render(
    <HeuristicDetailDrawer
      flag={flag}
      onJumpToTimeline={onJumpToTimeline}
      onJumpToReplay={onJumpToReplay}
      sessionOrdinals={opts.sessionOrdinals}
    >
      <button data-testid="open-btn">Open</button>
    </HeuristicDetailDrawer>,
  );

  return { flag, onJumpToTimeline, onJumpToReplay };
}

/** A FlagView whose two supporting events sit in different sessions. */
function crossSessionFlag(): FlagView {
  const event = (sessionId: string, seq: number, kind: string): IndexedEvent =>
    ({
      sessionId,
      seq,
      globalIdx: seq,
      wall: `2026-01-01T0${seq}:00:00.000Z`,
      t: seq * 1000,
      kind,
      payload: {},
      file: 'hw1.py',
    }) as unknown as IndexedEvent;

  return {
    id: 'external_edits-x',
    heuristic: 'external_edits',
    title: 'External edit across sessions',
    description: 'A file changed on disk between two sittings.',
    severity: 'high',
    confidence: 0.9,
    supporting: [
      { id: '1', globalIdx: 1, timelineSeq: 'sess-a:1', event: event('sess-a', 1, 'paste') },
      {
        id: '4',
        globalIdx: 4,
        timelineSeq: 'sess-b:4',
        event: event('sess-b', 4, 'fs.external_change'),
      },
    ],
  };
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

  it('jump button reports the ref it was rendered for', () => {
    const { onJumpToTimeline } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-btn-abc:2'));
    expect(onJumpToTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc:2', timelineSeq: 'abc:2' }),
    );
  });

  it('second jump button reports its own ref', () => {
    const { onJumpToTimeline } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-btn-abc:3'));
    expect(onJumpToTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc:3', timelineSeq: 'abc:3' }),
    );
  });

  it('replay button reports the resolved event, so the caller can name its session', () => {
    const { onJumpToReplay } = renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    fireEvent.click(screen.getByTestId('jump-replay-btn-abc:2'));
    expect(onJumpToReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'abc:2',
        event: expect.objectContaining({ sessionId: 'abc', globalIdx: 2 }),
      }),
    );
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

  // -------------------------------------------------------------------------
  // Multi-session presentation
  // -------------------------------------------------------------------------

  it('does not label sessions when all evidence sits in one', () => {
    // A header per row would be noise when there is nothing to tell apart.
    renderDrawer(0);
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.queryByTestId(/^supporting-session-header-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('spans-sessions-note')).not.toBeInTheDocument();
  });

  it('groups supporting events by session and says how many it spans', () => {
    renderDrawer(0, { flag: crossSessionFlag() });
    fireEvent.click(screen.getByTestId('open-btn'));

    expect(screen.getByTestId('supporting-session-header-sess-a')).toBeInTheDocument();
    expect(screen.getByTestId('supporting-session-header-sess-b')).toBeInTheDocument();
    expect(screen.getByTestId('spans-sessions-note').textContent).toContain('spans 2 sessions');
  });

  it('uses session ordinals in headers when the caller supplies them', () => {
    renderDrawer(0, {
      flag: crossSessionFlag(),
      sessionOrdinals: new Map([
        ['sess-a', 1],
        ['sess-b', 2],
      ]),
    });
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(screen.getByTestId('supporting-session-header-sess-b').textContent).toBe('Session 2');
  });

  it('keeps unresolved refs navigable while the index is still loading', () => {
    // The server Overview renders before it has paged the event stream. Evidence
    // must still be listed and jumpable — a supporting seq is a globalIdx, which
    // is all the destination needs.
    const flag: FlagView = {
      ...crossSessionFlag(),
      supporting: [{ id: '4880', globalIdx: 4880, timelineSeq: '4880', event: null }],
    };
    const { onJumpToTimeline } = renderDrawer(0, { flag });
    fireEvent.click(screen.getByTestId('open-btn'));

    expect(screen.getByText('event #4880')).toBeInTheDocument();
    const btn = screen.getByTestId('jump-btn-4880');
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    expect(onJumpToTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ globalIdx: 4880, timelineSeq: '4880' }),
    );
  });

  it('fires onOpen when the drawer opens', () => {
    const onOpen = vi.fn();
    render(
      <HeuristicDetailDrawer
        flag={toFlagViewFromLocal(fixtureFlags[0]!, makeMinimalIndex())}
        onJumpToTimeline={vi.fn()}
        onJumpToReplay={vi.fn()}
        onOpen={onOpen}
      >
        <button data-testid="open-btn">Open</button>
      </HeuristicDetailDrawer>,
    );
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('open-btn'));
    expect(onOpen).toHaveBeenCalled();
  });
});
