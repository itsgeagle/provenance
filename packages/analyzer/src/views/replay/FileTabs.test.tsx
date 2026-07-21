/**
 * Tests for FileTabs' whole-bundle behavior.
 *
 * The tab strip lists every file in the submission, so it must distinguish
 * "being edited right now" from "last touched two sessions ago" — otherwise a
 * stale tab looks like active work.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileTabs } from './FileTabs.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

function ev(globalIdx: number, sessionId: string, file: string, wall: string): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq: globalIdx,
    wall,
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: null,
    file,
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
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    if (e.file) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    bySessionId.set(e.sessionId, [...(bySessionId.get(e.sessionId) ?? []), e]);
  }
  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// hw1.py lives in sess-a only; hw2.py in sess-b only.
const INDEX = buildIndex([
  ev(0, 'sess-a', 'hw1.py', '2026-01-01T00:00:00.000Z'),
  ev(1, 'sess-b', 'hw2.py', '2026-01-02T00:00:00.000Z'),
  ev(2, 'sess-b', 'hw2.py', '2026-01-02T00:02:00.000Z'),
]);

const FILES = ['hw1.py', 'hw2.py'];

function renderTabs(currentGlobalIdx: number, currentSessionId: string, activeFile = 'hw2.py') {
  const onFileChange = vi.fn();
  render(
    <FileTabs
      files={FILES}
      activeFile={activeFile}
      onFileChange={onFileChange}
      index={INDEX}
      currentGlobalIdx={currentGlobalIdx}
      currentSessionId={currentSessionId}
    />,
  );
  return { onFileChange };
}

describe('FileTabs', () => {
  it('renders a tab for a file touched only in an earlier session', () => {
    renderTabs(2, 'sess-b');
    // hw1.py has no events in sess-b at all, but must still be listed.
    expect(screen.getByTestId('file-tab-hw1.py')).toBeInTheDocument();
    expect(screen.getByTestId('file-tab-hw2.py')).toBeInTheDocument();
  });

  it('dims a file with no event in the current session', () => {
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-hw1.py')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByTestId('file-tab-hw2.py')).not.toHaveAttribute('data-stale');
  });

  it('shows a session-distance badge for an earlier-session file', () => {
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-recency-hw1.py')).toHaveTextContent('1 session ago');
  });

  it('shows an elapsed-time badge for a current-session file', () => {
    // Playhead at 2 (00:02:00); hw2.py was also edited at 1 (00:00:00) — but the
    // last edit at or before the playhead IS event 2, so "now".
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-recency-hw2.py')).toHaveTextContent('now');
  });

  it('reports elapsed time when the current-session file was edited earlier', () => {
    // Playhead at 2, but ask about hw2.py's state from the playhead at 1's view.
    render(
      <FileTabs
        files={FILES}
        activeFile="hw2.py"
        onFileChange={vi.fn()}
        index={buildIndex([
          ev(0, 'sess-b', 'hw2.py', '2026-01-02T00:00:00.000Z'),
          ev(1, 'sess-b', 'other.py', '2026-01-02T00:02:00.000Z'),
        ])}
        currentGlobalIdx={1}
        currentSessionId="sess-b"
      />,
    );
    expect(screen.getByTestId('file-tab-recency-hw2.py')).toHaveTextContent('2m ago');
  });

  it('omits the badge for a file untouched at this playhead', () => {
    // Playhead at 0 (sess-a); hw2.py's first event is at globalIdx 1.
    renderTabs(0, 'sess-a', 'hw1.py');
    expect(screen.queryByTestId('file-tab-recency-hw2.py')).toBeNull();
    expect(screen.getByTestId('file-tab-hw2.py')).toHaveAttribute('data-stale', 'true');
  });

  it('renders plain tabs without recency when no index is supplied', () => {
    render(<FileTabs files={FILES} activeFile="hw1.py" onFileChange={vi.fn()} />);
    expect(screen.getByTestId('file-tab-hw1.py')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-recency-hw1.py')).toBeNull();
  });

  it('shows the empty state when there are no files', () => {
    render(<FileTabs files={[]} activeFile={null} onFileChange={vi.fn()} />);
    expect(screen.getByTestId('file-tabs-empty')).toBeInTheDocument();
  });
});
