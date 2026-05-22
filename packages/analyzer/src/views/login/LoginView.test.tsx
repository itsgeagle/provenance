/**
 * LoginView tests.
 *
 * - Renders "Sign in with Google" button.
 * - Shows error message when ?error=HOSTED_DOMAIN_MISMATCH is in URL.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginView } from './LoginView.js';

function renderLoginView(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <Routes>
        <Route path="/login" element={<LoginView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginView', () => {
  it('renders the sign-in button', () => {
    renderLoginView();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
  });

  it('renders the Provenance title', () => {
    renderLoginView();
    expect(screen.getByRole('heading', { name: /provenance/i })).toBeInTheDocument();
  });

  it('shows error message for HOSTED_DOMAIN_MISMATCH', () => {
    renderLoginView('?error=HOSTED_DOMAIN_MISMATCH');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/not on an allowed domain/i);
  });

  it('shows error message for EMAIL_NOT_VERIFIED', () => {
    renderLoginView('?error=EMAIL_NOT_VERIFIED');
    expect(screen.getByRole('alert')).toHaveTextContent(/email is not verified/i);
  });

  it('shows a generic error message for unknown error codes', () => {
    renderLoginView('?error=UNKNOWN_ERROR_CODE');
    expect(screen.getByRole('alert')).toHaveTextContent(/UNKNOWN_ERROR_CODE/);
  });

  it('does not show an error when there is no error param', () => {
    renderLoginView();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sign-in button posts to /api/v1/auth/google/start', () => {
    renderLoginView();
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form).toHaveAttribute('method', 'POST');
    expect(form?.getAttribute('action')).toContain('/api/v1/auth/google/start');
  });

  it('includes return_to=/home in form action by default', () => {
    renderLoginView();
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form?.getAttribute('action')).toContain('return_to=');
    expect(form?.getAttribute('action')).toContain('%2Fhome');
  });

  it('uses the next param as return_to when provided', () => {
    renderLoginView('?next=%2Fs%2Fsp25');
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form?.getAttribute('action')).toContain('%2Fs%2Fsp25');
  });
});
