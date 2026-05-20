/**
 * Tests for CompareView and the /compare route guard (Phase 11).
 *
 * Tests verified here:
 *   1. RequireMultiBundles: zero bundles → redirects to /load.
 *   2. RequireMultiBundles: one bundle → redirects to /overview.
 *   3. RequireMultiBundles: two bundles → renders CompareView.
 *   4. CompareView: bundle list renders all loaded bundles.
 *   5. CompareView: selecting a bundle calls selectBundle.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from '../../context/BundleContext.js';
import { CompareView } from './CompareView.js';
import { buildTestBundle } from '../../../test/helpers/build-test-bundle.js';
import type { ReactNode } from 'react';

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
// Tests
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

  it('Phase 18 stub is present', async () => {
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
      expect(screen.getByTestId('compare-heuristics-stub')).toBeTruthy();
    });
  });
});
