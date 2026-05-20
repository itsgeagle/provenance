/**
 * Header tests.
 *
 * Tests:
 * - Hidden when no bundle is loaded.
 * - Renders bundle filename, assignment id, session count badge.
 * - "Load different bundle" button calls clearBundle and navigates to /load.
 * - PartialLoadErrorBanner visible with filename + error when partialLoadErrors non-empty.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from '../context/BundleContext.js';
import { Header } from './Header.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';

// Wire SHA-512 override.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Helper: load a bundle into the context, then render the Header.
// ---------------------------------------------------------------------------

function LoadTrigger({ file }: { file: File }) {
  const { loadBundleFile } = useBundle();
  return (
    <button
      data-testid="load-btn"
      onClick={() => {
        void loadBundleFile(file);
      }}
    >
      load
    </button>
  );
}

function renderHeaderWithBundle(file: File) {
  const loadPage = <div data-testid="load-page">Load</div>;

  return render(
    <MemoryRouter initialEntries={['/overview']}>
      <BundleProvider>
        <Header />
        <LoadTrigger file={file} />
        <Routes>
          <Route path="/load" element={loadPage} />
          <Route path="/overview" element={<div>Overview</div>} />
        </Routes>
      </BundleProvider>
    </MemoryRouter>,
  );
}

function LoadFilesTrigger({ files }: { files: File[] }) {
  const { loadBundleFiles } = useBundle();
  return (
    <button
      data-testid="load-files-btn"
      onClick={() => {
        void loadBundleFiles(files);
      }}
    >
      load files
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Header', () => {
  it('is not rendered when no bundle is loaded', () => {
    render(
      <MemoryRouter>
        <BundleProvider>
          <Header />
        </BundleProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('header')).not.toBeInTheDocument();
  });

  it('renders filename, assignment id, and session count after loading', async () => {
    const { blob } = await buildTestBundle({
      assignmentId: 'hw3',
      sessions: [{ eventCount: 2 }, { eventCount: 3 }],
    });
    const file = new File([blob], 'hw3-bundle.zip', { type: 'application/zip' });

    renderHeaderWithBundle(file);

    act(() => {
      screen.getByTestId('load-btn').click();
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    expect(screen.getByTestId('header-filename').textContent).toBe('hw3-bundle.zip');
    expect(screen.getByTestId('header-assignment-id').textContent).toContain('hw3');
    expect(screen.getByTestId('header-session-count').textContent).toContain('2');
  });

  it('"Load different bundle" button clears the bundle and navigates to /load', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 1 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderHeaderWithBundle(file);

    act(() => {
      screen.getByTestId('load-btn').click();
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    act(() => {
      screen.getByTestId('header-load-different-btn').click();
    });

    // Header should disappear (bundle cleared) and navigate to /load.
    await vi.waitFor(() => {
      expect(screen.queryByTestId('header')).not.toBeInTheDocument();
      expect(screen.getByTestId('load-page')).toBeInTheDocument();
    });
  });

  it('shows PartialLoadErrorBanner when some files fail to load', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const validFile = new File([blob], 'good.zip', { type: 'application/zip' });
    const badFile = new File(['garbage'], 'bad.zip', { type: 'application/zip' });

    render(
      <MemoryRouter initialEntries={['/overview']}>
        <BundleProvider>
          <Header />
          <LoadFilesTrigger files={[validFile, badFile]} />
          <Routes>
            <Route path="/overview" element={<div>Overview</div>} />
          </Routes>
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    // Wait for the successful bundle to finish loading (header appears).
    await waitFor(() => {
      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    // Banner must be visible and reference the failing filename.
    const banner = screen.getByTestId('partial-load-error-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('bad.zip');

    // Dismiss button hides the banner.
    act(() => {
      screen.getByTestId('partial-load-error-dismiss').click();
    });
    expect(screen.queryByTestId('partial-load-error-banner')).not.toBeInTheDocument();
  });
});
