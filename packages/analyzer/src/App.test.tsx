/**
 * App routing tests.
 *
 * Tests:
 * - / redirects to /home (v3 behavior; RequireAuth redirects to /login if unauthed)
 * - /load shows the drop zone (legacy v2 route preserved)
 * - /overview redirects to /load when no bundle loaded (legacy v2 guard preserved)
 * - /timeline redirects to /load when no bundle loaded (legacy v2 guard preserved)
 * - After loading a bundle, /load navigates to /overview (legacy v2 behavior preserved)
 *
 * All tests wrap App with QueryClientProvider because App now renders RequireAuth
 * at /home which calls useMe().
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { App } from './App.js';
import { buildTestBundle } from '../test/helpers/build-test-bundle.js';
import { mswServer } from './test-setup.js';
import { meUnauthorizedHandler } from './test/msw-handlers.js';

// Wire SHA-512 override.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderApp(initialPath: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App routing', () => {
  it('redirects / to /home (unauthenticated → /login)', async () => {
    // Unauthenticated: /me returns 401 → RequireAuth redirects to /login
    mswServer.use(meUnauthorizedHandler());

    renderApp('/');

    // / → /home → RequireAuth(401) → /login
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
  });

  it('renders load view at /load', () => {
    renderApp('/load');
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('RequireBundle redirects /overview to /load when no bundle is loaded', () => {
    renderApp('/overview');
    // Should redirect to /load and show the drop zone.
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('RequireBundle redirects /timeline to /load when no bundle is loaded', () => {
    renderApp('/timeline');
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });

  it('after a bundle is loaded, /load navigates to /overview', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderApp('/load');

    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    // After load completes, the app should navigate to /overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
