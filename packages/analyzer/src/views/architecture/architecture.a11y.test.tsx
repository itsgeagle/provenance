import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import ArchitectureView from './ArchitectureView.js';

vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

describe('architecture accessibility', () => {
  it('gives every diagram viewport an accessible name', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const apps = screen.getAllByRole('application');
    expect(apps).toHaveLength(13);
    apps.forEach((a) => expect(a).toHaveAccessibleName());
  });

  it('makes diagram nodes reachable as buttons', () => {
    const { container } = render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const nodes = container.querySelectorAll('g.node[role="button"][tabindex="0"]');
    expect(nodes.length).toBeGreaterThan(50);
    nodes.forEach((n) => expect(n.getAttribute('aria-label')).toBeTruthy());
  });

  it('moves focus to the detail panel when a node is selected', () => {
    const { container } = render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const node = container.querySelector('g.node') as SVGGElement;
    fireEvent.click(node);
    expect(document.activeElement).toHaveAttribute('aria-label', 'Node details');
  });
});
