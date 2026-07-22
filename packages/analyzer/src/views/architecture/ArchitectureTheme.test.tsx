// NOTE: the repo has no `@testing-library/user-event` dependency and adding one
// is out of scope, so interactions here use `fireEvent` (which RTL already
// wraps in `act`). Assertions are unchanged.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArchitectureTheme, ArchThemeToggle, useArchTheme } from './ArchitectureTheme.js';

function Probe() {
  const { resolved } = useArchTheme();
  return <span data-testid="resolved">{resolved}</span>;
}

function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: prefersDark && q.includes('dark'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('ArchitectureTheme', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the OS preference', () => {
    mockMatchMedia(true);
    render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('scopes the theme to its own wrapper, never the document', () => {
    mockMatchMedia(true);
    const { container } = render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(container.querySelector('[data-arch-theme="dark"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggling persists the explicit choice', () => {
    mockMatchMedia(false);
    render(
      <ArchitectureTheme>
        <ArchThemeToggle />
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    fireEvent.click(screen.getByRole('button', { name: /switch to dark/i }));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(localStorage.getItem('prov-arch-theme')).toBe('dark');
  });

  it('restores a persisted choice over the OS preference', () => {
    localStorage.setItem('prov-arch-theme', 'light');
    mockMatchMedia(true);
    render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });
});
