import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GoogleSignInButton } from './GoogleSignInButton.js';

describe('GoogleSignInButton', () => {
  it('renders a submit button labelled "Sign in with Google"', () => {
    render(<GoogleSignInButton />);
    const button = screen.getByRole('button', { name: /sign in with google/i });
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('posts to /api/v1/auth/google/start with return_to=/home by default', () => {
    render(<GoogleSignInButton />);
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form).toHaveAttribute('method', 'POST');
    expect(form?.getAttribute('action')).toContain('/api/v1/auth/google/start');
    expect(form?.getAttribute('action')).toContain('return_to=');
    expect(form?.getAttribute('action')).toContain('%2Fhome');
  });

  it('encodes a custom returnTo into the form action', () => {
    render(<GoogleSignInButton returnTo="/s/cs61a/sp25" />);
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form?.getAttribute('action')).toContain('%2Fs%2Fcs61a%2Fsp25');
  });

  it('marks the Google icon as decorative (aria-hidden)', () => {
    const { container } = render(<GoogleSignInButton />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
