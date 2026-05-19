/**
 * LoadView tests.
 *
 * Tests:
 * - Drop event triggers the bundle loader.
 * - File picker change event triggers the loader.
 * - On status === 'loaded', navigates to /overview.
 * - LoadingPanel displays the current loading stage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider } from '../../context/BundleContext.js';
import { LoadView } from './LoadView.js';
import { buildTestBundle } from '../../../test/helpers/build-test-bundle.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Helper: wrap LoadView with router and provider
// ---------------------------------------------------------------------------

function renderLoadView(initialEntries = ['/load']) {
  const overviewContent = <div data-testid="overview-reached">Overview</div>;

  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <BundleProvider>
        <Routes>
          <Route path="/load" element={<LoadView />} />
          <Route path="/overview" element={overviewContent} />
        </Routes>
      </BundleProvider>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoadView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the drop zone', () => {
    renderLoadView();
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    expect(screen.getByTestId('choose-file-btn')).toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('drop event on the drop zone triggers the loader and navigates to /overview', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    const dropZone = screen.getByTestId('drop-zone');

    // Create a synthetic DataTransfer.
    const dataTransfer = {
      files: [file] as unknown as FileList,
    };

    act(() => {
      fireEvent.drop(dropZone, { dataTransfer });
    });

    // Should show loading panel while loading.
    await waitFor(() => {
      expect(screen.queryByTestId('loading-panel')).toBeInTheDocument();
    });

    // After load completes, should navigate to /overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('file picker change event triggers the loader', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 1 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    const fileInput = screen.getByTestId('file-input');

    act(() => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Should eventually navigate to /overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('shows LoadingPanel with stage label during loading', async () => {
    // Use a "never-resolving" file to catch the loading state in flight.
    // We do this by dropping a structurally-valid large-ish bundle and
    // checking the panel appears before navigation.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    // The loading panel should appear immediately after the drop.
    await waitFor(() => {
      expect(screen.getByTestId('loading-panel')).toBeInTheDocument();
    });

    expect(screen.getByTestId('loading-stage-label')).toBeInTheDocument();
  });

  it('shows ErrorPanel on an invalid file drop', async () => {
    const file = new File(['not a zip'], 'bad.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('error-panel')).toBeInTheDocument();
    });
  });

  it('retrying after error clears the error panel', async () => {
    const badFile = new File(['not a zip'], 'bad.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [badFile] as unknown as FileList },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('error-panel')).toBeInTheDocument();
    });

    // Click "Try a different file" to retry.
    act(() => {
      screen.getByTestId('error-retry-btn').click();
    });

    // Drop zone should reappear.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });
});
