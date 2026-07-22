import { render, screen } from '@testing-library/react';
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

describe('ArchitectureView', () => {
  it('renders all 13 sections with their diagrams', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /end-to-end map/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /roadmap/i })).toBeInTheDocument();
    expect(screen.getAllByRole('figure')).toHaveLength(13);
  });

  it('exposes a table of contents', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const toc = screen.getByRole('navigation', { name: /sections/i });
    expect(toc).toBeInTheDocument();
  });

  it('has a theme toggle and does not touch the document theme', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /switch to dark/i })).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
