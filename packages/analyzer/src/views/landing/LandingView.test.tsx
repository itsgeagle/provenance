/**
 * LandingView tests.
 *
 * - Anonymous: renders the sign-in button, the h1, and the three sections.
 * - Authenticated: renders an "Open dashboard" link instead of the button.
 * - Accessibility smoke: exactly one h1, a main landmark.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mswServer } from '../../test-setup.js';
import { meUnauthorizedHandler } from '../../test/msw-handlers.js';
import { LandingView } from './LandingView.js';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderLanding() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <LandingView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LandingView', () => {
  it('renders exactly one h1 titled "Provenance" inside a main landmark', () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/provenance/i);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the three explainer section headings', () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    expect(screen.getByRole('heading', { level: 2, name: /what it does/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /protects honest students/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /integrity/i })).toBeInTheDocument();
  });

  it('shows the sign-in button when the visitor is not authenticated', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /open dashboard/i })).not.toBeInTheDocument();
  });

  it('shows an "Open dashboard" link to /home when the visitor is authenticated', async () => {
    // Default handler returns an authenticated user.
    renderLanding();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /open dashboard/i });
      expect(link).toHaveAttribute('href', '/home');
    });
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('offers a contact mailto link with a pre-filled subject', () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    const link = screen.getByRole('link', { name: /reach out/i });
    expect(link).toHaveAttribute(
      'href',
      'mailto:aaryanm@berkeley.edu?subject=Question%20about%20Provenance',
    );
  });
});
