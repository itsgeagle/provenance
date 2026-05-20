/**
 * ReplayView.test.tsx
 *
 * Tests:
 *  1. Route guard: sessionId not found → navigates to /overview.
 *  2. Session found → renders replay view.
 *  3. URL ?event param is read on mount and seeked to.
 *  4. FileTabs renders with files list.
 *  5. TransportBar renders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReplayView } from './ReplayView.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import type { BundleContextValue } from '../../context/BundleContext.js';

// ---------------------------------------------------------------------------
// Mock Monaco so lazy import resolves immediately in jsdom.
// ---------------------------------------------------------------------------
vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco-editor" data-value={value} />,
}));

// ---------------------------------------------------------------------------
// Minimal index builder
// ---------------------------------------------------------------------------

function makeDocChangeEvent(globalIdx: number, sessionId: string, file: string): IndexedEvent {
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: {
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: String.fromCharCode(65 + globalIdx), // A, B, C, ...
        },
      ],
    },
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

// ---------------------------------------------------------------------------
// Test wrapper that mocks useBundle() at the module level.
// We mock the BundleContext module so useBundle() returns a controlled value.
// ---------------------------------------------------------------------------

// We use vi.mock to intercept useBundle at the module boundary.
const mockIndex = { current: null as EventIndex | null };

vi.mock('../../context/BundleContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/BundleContext.js')>();
  return {
    ...actual,
    useBundle: (): BundleContextValue => ({
      bundles: [],
      selectedBundleId: null,
      selectBundle: vi.fn(),
      indicesByBundle: new Map(),
      validationReportByBundle: new Map(),
      flagsByBundle: new Map(),
      index: mockIndex.current,
      validationReport: null,
      flags: [],
      crossFlags: [],
      status: mockIndex.current !== null ? ('loaded' as const) : ('idle' as const),
      loadingStage: null,
      loadError: null,
      partialLoadErrors: [],
      loadBundleFile: vi.fn(),
      loadBundleFiles: vi.fn(),
      clearBundle: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderReplayView(sessionId: string, search = '') {
  const path = `/replay/${sessionId}${search}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/replay/:sessionId" element={<ReplayView />} />
        <Route path="/overview" element={<div data-testid="overview-view">Overview</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplayView', () => {
  beforeEach(() => {
    mockIndex.current = null;
  });

  describe('route guard', () => {
    it('redirects to /overview when index is null', async () => {
      mockIndex.current = null;
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('overview-view')).toBeDefined();
      });
    });

    it('redirects to /overview when sessionId not found', async () => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'other-session', 'hw.py')]);
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderReplayView('missing-session');
      await waitFor(() => {
        expect(screen.getByTestId('overview-view')).toBeDefined();
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found in index'));
      spy.mockRestore();
    });
  });

  describe('with a valid session', () => {
    beforeEach(() => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeDocChangeEvent(1, 'sess1', 'hw.py'),
        makeDocChangeEvent(2, 'sess1', 'hw.py'),
      ]);
    });

    it('renders the replay-view container', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-view')).toBeDefined();
      });
    });

    it('renders the transport bar', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('transport-bar')).toBeDefined();
      });
    });

    it('renders file tabs', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('file-tabs')).toBeDefined();
      });
    });

    it('renders Monaco editor after Suspense resolves', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor')).toBeDefined();
      });
    });

    it('reads ?event URL param on mount and shows that content', async () => {
      // event=2 means seek to globalIdx 2 (inclusive), so 3 inserts: A, B, C at pos 0.
      // Event 0 inserts 'A' → 'A'
      // Event 1 inserts 'B' at pos 0 → 'BA'
      // Event 2 inserts 'C' at pos 0 → 'CBA'
      renderReplayView('sess1', '?event=2');
      await waitFor(() => {
        const editor = screen.getByTestId('monaco-editor');
        expect(editor.getAttribute('data-value')).toBe('CBA');
      });
    });
  });

  describe('session with no file events', () => {
    it('shows no-file placeholder', async () => {
      mockIndex.current = buildIndex([
        {
          sessionId: 'sess1',
          seq: 0,
          globalIdx: 0,
          wall: '2026-01-01T00:00:00.000Z',
          t: 0,
          kind: 'session.start',
          payload: null,
        },
      ]);
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('no-file-placeholder')).toBeDefined();
      });
    });
  });
});
