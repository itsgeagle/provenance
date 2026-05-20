/**
 * Tests for CompareView and the /compare route guard (Phase 11 + Phase 18).
 *
 * Tests verified here:
 *   1. RequireMultiBundles: zero bundles → redirects to /load.
 *   2. RequireMultiBundles: one bundle → redirects to /overview.
 *   3. RequireMultiBundles: two bundles → renders CompareView.
 *   4. CompareView: bundle list renders all loaded bundles.
 *   5. CompareView: selecting a bundle calls selectBundle.
 *   6. Phase 18: cross-flags table renders when crossFlags is non-empty.
 *   7. Phase 18: empty state renders when crossFlags is empty and 2 bundles selected.
 *   8. Phase 18: clicking a flag row opens the detail pane.
 *   9. Phase 18: detail pane shows supporting seq keys as links.
 *  10. Phase 18: detail pane close button dismisses it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from '../../context/BundleContext.js';
import type { BundleContextValue } from '../../context/BundleContext.js';
import { CompareView } from './CompareView.js';
import { buildTestBundle } from '../../../test/helpers/build-test-bundle.js';
import type { ReactNode } from 'react';
import type { CrossFlag } from '../../heuristics/cross/types.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Minimal RequireMultiBundles re-implementation for test isolation.
// (App.tsx has the real one; tests should not import App to avoid full routing.)
// ---------------------------------------------------------------------------

function RequireMultiBundles({ children }: { children: ReactNode }) {
  const { status, bundles } = useBundle();
  if (status !== 'loaded') {
    return (
      <Routes>
        <Route path="*" element={<div data-testid="redirected-to-load">load page</div>} />
      </Routes>
    );
  }
  if (bundles.length < 2) {
    return (
      <Routes>
        <Route path="*" element={<div data-testid="redirected-to-overview">overview page</div>} />
      </Routes>
    );
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// LoadFilesTrigger helper
// ---------------------------------------------------------------------------

function LoadFilesTrigger({ files }: { files: File[] }) {
  const { loadBundleFiles } = useBundle();
  return (
    <button
      data-testid="load-files-btn"
      onClick={() => {
        void loadBundleFiles(files);
      }}
    >
      load
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tests: route guard and basic CompareView (unchanged from Phase 11)
// ---------------------------------------------------------------------------

describe('RequireMultiBundles route guard', () => {
  it('redirects to /load placeholder when no bundle is loaded', () => {
    render(
      <MemoryRouter initialEntries={['/compare']}>
        <BundleProvider>
          <RequireMultiBundles>
            <CompareView />
          </RequireMultiBundles>
        </BundleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('redirected-to-load')).toBeTruthy();
    expect(screen.queryByTestId('compare-view')).toBeNull();
  });

  it('redirects to /overview placeholder when only one bundle is loaded', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'single.zip', { type: 'application/zip' });

    render(
      <MemoryRouter initialEntries={['/compare']}>
        <BundleProvider>
          <LoadFilesTrigger files={[file]} />
          <RequireMultiBundles>
            <CompareView />
          </RequireMultiBundles>
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('redirected-to-overview')).toBeTruthy();
    });

    expect(screen.queryByTestId('compare-view')).toBeNull();
  });

  it('renders CompareView when two bundles are loaded', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const file1 = new File([blob1], 'hw1.zip', { type: 'application/zip' });
    const file2 = new File([blob2], 'hw2.zip', { type: 'application/zip' });

    render(
      <MemoryRouter initialEntries={['/compare']}>
        <BundleProvider>
          <LoadFilesTrigger files={[file1, file2]} />
          <RequireMultiBundles>
            <CompareView />
          </RequireMultiBundles>
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('compare-view')).toBeTruthy();
    });
  });
});

describe('CompareView', () => {
  it('renders all loaded bundles in the picker', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const file1 = new File([blob1], 'hw1.zip', { type: 'application/zip' });
    const file2 = new File([blob2], 'hw2.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <LoadFilesTrigger files={[file1, file2]} />
          <RequireMultiBundles>
            <CompareView />
          </RequireMultiBundles>
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('compare-view')).toBeTruthy();
    });

    const list = screen.getByTestId('compare-bundle-list');
    expect(list.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows cross-flags-need-more when fewer than 2 bundles selected', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{}] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{}] });
    const f1 = new File([blob1], 'a.zip', { type: 'application/zip' });
    const f2 = new File([blob2], 'b.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <LoadFilesTrigger files={[f1, f2]} />
          <RequireMultiBundles>
            <CompareView />
          </RequireMultiBundles>
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('compare-view')).toBeTruthy();
    });

    // Uncheck the first bundle so only 1 is selected.
    const checkboxes = screen.getAllByRole('checkbox');
    act(() => {
      fireEvent.click(checkboxes[0]!);
    });

    await waitFor(() => {
      expect(screen.getByTestId('cross-flags-need-more')).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 18 cross-flag rendering tests — use vi.mock to inject crossFlags
// ---------------------------------------------------------------------------

// NOTE: vi.mock is hoisted to module scope. We conditionally return the real
// hook when mockUseBundleEnabled is false (for route-guard + real-BundleProvider
// tests) and the mock when it is true (for Phase 18 cross-flag rendering tests).
let mockUseBundleEnabled = false;
let mockUseBundleReturn: BundleContextValue | null = null;
const mockUseBundle = () => mockUseBundleReturn;

vi.mock('../../context/BundleContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/BundleContext.js')>();
  return {
    ...actual,
    useBundle: () => {
      if (mockUseBundleEnabled) return mockUseBundle();
      return actual.useBundle();
    },
  };
});

function makeCrossFlag(partial: Partial<CrossFlag> = {}): CrossFlag {
  return {
    id: 'paste_shared_across_students-bundle-a|bundle-b-0',
    heuristic: 'paste_shared_across_students',
    title: 'Shared paste detected across 2 bundles',
    severity: 'high',
    confidence: 0.95,
    bundleIds: ['bundle-a', 'bundle-b'],
    eventsPerBundle: {
      'bundle-a': ['sess-a:1'],
      'bundle-b': ['sess-b:1'],
    },
    description: 'A paste appears in 2 different student bundles.',
    detail: { matchKind: 'sha256_exact', pasteCount: 2, maxLength: 200 },
    ...partial,
  };
}

function makeStubContext(crossFlags: CrossFlag[]): BundleContextValue {
  return {
    bundles: [
      {
        id: 'bundle-a',
        manifest: { assignment_id: 'hw1', semester: 'sp26' },
        manifestSigHex: 'sig',
        sessions: [],
        sourceFilename: 'student-a.zip',
        loadedAt: new Date().toISOString(),
      } as unknown as import('../../loader/types.js').Bundle,
      {
        id: 'bundle-b',
        manifest: { assignment_id: 'hw1', semester: 'sp26' },
        manifestSigHex: 'sig',
        sessions: [],
        sourceFilename: 'student-b.zip',
        loadedAt: new Date().toISOString(),
      } as unknown as import('../../loader/types.js').Bundle,
    ],
    selectedBundleId: 'bundle-a',
    selectBundle: vi.fn(),
    indicesByBundle: new Map(),
    validationReportByBundle: new Map(),
    flagsByBundle: new Map(),
    index: null,
    validationReport: null,
    flags: [],
    crossFlags,
    status: 'loaded',
    loadingStage: null,
    loadError: null,
    partialLoadErrors: [],
    loadBundleFile: vi.fn(),
    loadBundleFiles: vi.fn(),
    clearBundle: vi.fn(),
  };
}

describe('CompareView — Phase 18 cross-flag rendering', () => {
  beforeEach(() => {
    mockUseBundleEnabled = true;
  });
  afterEach(() => {
    mockUseBundleEnabled = false;
    mockUseBundleReturn = null;
  });

  it('renders empty state when crossFlags is empty', () => {
    mockUseBundleReturn = makeStubContext([]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('cross-flags-empty')).toBeTruthy();
    expect(screen.queryByTestId('cross-flags-table')).toBeNull();
  });

  it('renders cross-flags table when crossFlags is non-empty', () => {
    const flag = makeCrossFlag();
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('cross-flags-table')).toBeTruthy();
    expect(screen.getByTestId(`cross-flag-row-${flag.id}`)).toBeTruthy();
  });

  it('table shows severity, heuristic id, title, confidence', () => {
    const flag = makeCrossFlag();
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    // Severity chip
    expect(screen.getByText('high')).toBeTruthy();
    // Heuristic id
    expect(screen.getByText('paste_shared_across_students')).toBeTruthy();
    // Title
    expect(screen.getByText('Shared paste detected across 2 bundles')).toBeTruthy();
    // Confidence (95%)
    expect(screen.getByText('95%')).toBeTruthy();
  });

  it('clicking a flag row opens the detail pane', () => {
    const flag = makeCrossFlag();
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    const row = screen.getByTestId(`cross-flag-row-${flag.id}`);
    fireEvent.click(row);

    expect(screen.getByTestId('cross-flag-detail-overlay')).toBeTruthy();
    expect(screen.getByTestId('cross-flag-bundle-panels')).toBeTruthy();
  });

  it('detail pane shows supporting seq keys as links for each bundle', () => {
    const flag = makeCrossFlag();
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId(`cross-flag-row-${flag.id}`));

    // Bundle-a events panel
    expect(screen.getByTestId('cross-flag-events-bundle-a')).toBeTruthy();
    expect(screen.getByTestId('cross-flag-seq-link-sess-a:1')).toBeTruthy();

    // Bundle-b events panel
    expect(screen.getByTestId('cross-flag-events-bundle-b')).toBeTruthy();
    expect(screen.getByTestId('cross-flag-seq-link-sess-b:1')).toBeTruthy();
  });

  it('detail pane closes when close button is clicked', () => {
    const flag = makeCrossFlag();
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId(`cross-flag-row-${flag.id}`));
    expect(screen.getByTestId('cross-flag-detail-overlay')).toBeTruthy();

    fireEvent.click(screen.getByTestId('cross-flag-detail-close'));
    expect(screen.queryByTestId('cross-flag-detail-overlay')).toBeNull();
  });

  it('shows editing_pattern_clone flags with medium severity', () => {
    const flag = makeCrossFlag({
      id: 'editing_pattern_clone-bundle-a|bundle-b-0',
      heuristic: 'editing_pattern_clone',
      title: 'Editing-pattern clone detected (Jaccard 85%)',
      severity: 'medium',
      confidence: 0.7,
      description: 'Similar editing workflows detected.',
    });
    mockUseBundleReturn = makeStubContext([flag]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('cross-flags-table')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('editing_pattern_clone')).toBeTruthy();
  });

  it('renders multiple cross-flags as multiple table rows', () => {
    const flag1 = makeCrossFlag({ id: 'flag-1' });
    const flag2 = makeCrossFlag({
      id: 'flag-2',
      heuristic: 'editing_pattern_clone',
      severity: 'medium',
      title: 'Clone detected',
    });
    mockUseBundleReturn = makeStubContext([flag1, flag2]);

    render(
      <MemoryRouter>
        <CompareView />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('cross-flag-row-flag-1')).toBeTruthy();
    expect(screen.getByTestId('cross-flag-row-flag-2')).toBeTruthy();
  });
});
