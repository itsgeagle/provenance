/**
 * TokensView tests.
 *
 * Covered behaviour:
 * - Lists existing tokens with status badges (active / revoked / expired).
 * - Create form posts to /me/tokens and opens the one-time secret modal.
 * - Secret modal blocks "Done" until the acknowledge checkbox is checked.
 * - Acknowledging the modal clears the secret from the DOM.
 * - Revoke flow requires the two-step confirm.
 * - Selecting the "Restrict to specific semesters" scope renders the semester
 *   picker and forces a selection before the form can submit.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { TokensView } from './TokensView.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_TOKEN = {
  id: '11111111-1111-1111-1111-111111111111',
  label: 'ci-script',
  prefix: 'aBc12XyZ',
  scopes: {
    read_only: true,
    semester_ids: null,
    include_blobs: false,
  },
  last_used_at: '2026-05-20T12:00:00.000Z',
  expires_at: null,
  revoked_at: null,
  created_at: '2026-05-01T00:00:00.000Z',
};

const REVOKED_TOKEN = {
  id: '22222222-2222-2222-2222-222222222222',
  label: 'old-token',
  prefix: 'oLd11AaA',
  scopes: {
    read_only: false,
    semester_ids: ['00000000-0000-0000-0000-000000000010'],
    include_blobs: true,
  },
  last_used_at: null,
  expires_at: null,
  revoked_at: '2026-04-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
};

function tokensListHandler(tokens: unknown[]) {
  return http.get('/api/v1/me/tokens', () => HttpResponse.json({ tokens }));
}

function renderTokensView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/me/tokens']}>
        <TokensView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokensView', () => {
  it('renders existing tokens with status badges', async () => {
    mswServer.use(tokensListHandler([ACTIVE_TOKEN, REVOKED_TOKEN]));

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('tokens-table')).toBeInTheDocument(), {
      timeout: 3000,
    });

    expect(screen.getByText('ci-script')).toBeInTheDocument();
    expect(screen.getByText('old-token')).toBeInTheDocument();
    expect(screen.getByTestId(`token-row-${ACTIVE_TOKEN.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('status-active')).toBeInTheDocument();
    expect(screen.getByTestId('status-revoked')).toBeInTheDocument();
  });

  it('shows the empty-state message when no tokens exist', async () => {
    mswServer.use(tokensListHandler([]));

    renderTokensView();

    await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('disables create until label is filled', async () => {
    mswServer.use(tokensListHandler([]));

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('create-token-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    const submit = screen.getByTestId('create-token-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('token-label-input'), {
      target: { value: 'my-token' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('creates a token and opens the one-time secret modal', async () => {
    let createPayload: { label?: string; scopes?: unknown } = {};
    mswServer.use(
      tokensListHandler([]),
      http.post('/api/v1/me/tokens', async ({ request }) => {
        createPayload = (await request.json()) as typeof createPayload;
        return HttpResponse.json(
          {
            token: {
              ...ACTIVE_TOKEN,
              label: createPayload.label ?? '',
            },
            secret: 'prov_aBc12XyZ_thisisaverylongsecretvalue',
          },
          { status: 201 },
        );
      }),
    );

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('create-token-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('token-label-input'), {
      target: { value: 'my-token' },
    });
    fireEvent.click(screen.getByTestId('create-token-submit'));

    await waitFor(() => expect(screen.getByTestId('secret-modal')).toBeInTheDocument(), {
      timeout: 3000,
    });

    const secretField = screen.getByTestId('secret-value') as HTMLTextAreaElement;
    expect(secretField.value).toBe('prov_aBc12XyZ_thisisaverylongsecretvalue');
    expect(createPayload.label).toBe('my-token');
    expect(createPayload.scopes).toMatchObject({ read_only: true, include_blobs: false });

    const doneBtn = screen.getByTestId('secret-ack-close') as HTMLButtonElement;
    expect(doneBtn.disabled).toBe(true);
  });

  it('clears the secret from the DOM only after acknowledgement', async () => {
    mswServer.use(
      tokensListHandler([]),
      http.post('/api/v1/me/tokens', () =>
        HttpResponse.json(
          { token: ACTIVE_TOKEN, secret: 'prov_aBc12XyZ_thisisaverylongsecretvalue' },
          { status: 201 },
        ),
      ),
    );

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('create-token-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('token-label-input'), {
      target: { value: 'my-token' },
    });
    fireEvent.click(screen.getByTestId('create-token-submit'));

    await waitFor(() => expect(screen.getByTestId('secret-modal')).toBeInTheDocument(), {
      timeout: 3000,
    });

    // Tick the acknowledge checkbox, then close.
    fireEvent.click(screen.getByTestId('secret-ack-checkbox'));
    const doneBtn = screen.getByTestId('secret-ack-close') as HTMLButtonElement;
    expect(doneBtn.disabled).toBe(false);
    fireEvent.click(doneBtn);

    await waitFor(() => expect(screen.queryByTestId('secret-modal')).toBeNull(), {
      timeout: 3000,
    });
    expect(screen.queryByTestId('secret-value')).toBeNull();
  });

  it('revoke requires two-step confirm', async () => {
    let deleted = false;
    mswServer.use(
      tokensListHandler([ACTIVE_TOKEN]),
      http.delete(`/api/v1/me/tokens/${ACTIVE_TOKEN.id}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('tokens-table')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByTestId(`revoke-btn-${ACTIVE_TOKEN.id}`));
    expect(deleted).toBe(false); // first click only opens the confirm
    expect(screen.getByTestId(`revoke-confirm-${ACTIVE_TOKEN.id}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`revoke-confirm-${ACTIVE_TOKEN.id}`));
    await waitFor(() => expect(deleted).toBe(true), { timeout: 3000 });
  });

  it('semester restriction forces a selection before submit', async () => {
    mswServer.use(tokensListHandler([]));

    renderTokensView();

    await waitFor(() => expect(screen.getByTestId('create-token-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('token-label-input'), {
      target: { value: 'restricted' },
    });
    fireEvent.click(screen.getByTestId('scope-restrict-semesters'));

    // Semester picker should appear; the default /me handler returns one
    // membership with slug `sp25`, so its checkbox is available.
    await waitFor(() => expect(screen.getByTestId('semester-picker')).toBeInTheDocument(), {
      timeout: 3000,
    });

    const submit = screen.getByTestId('create-token-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('semester-checkbox-sp25'));
    expect(submit.disabled).toBe(false);
  });
});
