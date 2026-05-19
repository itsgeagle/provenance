/**
 * App routing tests (Phase 5).
 *
 * Tests:
 * - RequireBundle redirects /overview → /load when no bundle loaded.
 * - RequireBundle redirects /timeline → /load when no bundle loaded.
 * - / redirects to /load.
 * - After loading a bundle, /overview is accessible without redirect.
 *
 * Note: the old __placeholder__/setup.test.tsx is removed — these tests
 * provide equivalent and stronger coverage.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { App } from './App.js';
import { buildTestBundle } from '../test/helpers/build-test-bundle.js';

// Wire SHA-512 override.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App routing', () => {
  it('redirects / to /load (drop zone shown)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('renders load view at /load', () => {
    render(
      <MemoryRouter initialEntries={['/load']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('RequireBundle redirects /overview to /load when no bundle is loaded', () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <App />
      </MemoryRouter>,
    );
    // Should redirect to /load and show the drop zone.
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('RequireBundle redirects /timeline to /load when no bundle is loaded', () => {
    render(
      <MemoryRouter initialEntries={['/timeline']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('after a bundle is loaded, /load navigates to /overview', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    render(
      <MemoryRouter initialEntries={['/load']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    // After load completes, the app should navigate to /overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-placeholder')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
