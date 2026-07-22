import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ArchitectureView from './ArchitectureView.js';

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

describe('ArchitectureView', () => {
  beforeEach(() => {
    localStorage.clear();
    mockMatchMedia(false);
  });

  it('renders all 13 plates', () => {
    const { container } = render(<ArchitectureView />);
    expect(container.querySelectorAll('.arch-plate')).toHaveLength(13);
  });

  it('renders the search button and the theme toggle', () => {
    render(<ArchitectureView />);
    expect(screen.getByRole('button', { name: /search the map/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /switch to (dark|light) mode/i }),
    ).toBeInTheDocument();
  });

  it('does not put the theme on document.documentElement — it stays scoped', () => {
    render(<ArchitectureView />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.hasAttribute('data-arch-theme')).toBe(false);
  });

  it('the viewport is an application landmark with an accessible name', () => {
    render(<ArchitectureView />);
    const viewport = screen.getByRole('application');
    expect(viewport).toHaveAccessibleName();
  });

  it('exposes at least 50 keyboard-activatable, labelled nodes across the map', () => {
    const { container } = render(<ArchitectureView />);
    const nodes = container.querySelectorAll('g.node[role="button"][tabindex="0"]');
    expect(nodes.length).toBeGreaterThanOrEqual(50);
    nodes.forEach((n) => expect(n.getAttribute('aria-label')).toBeTruthy());
  });
});
