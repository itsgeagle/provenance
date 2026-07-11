import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RowLink } from './RowLink.js';

describe('RowLink', () => {
  it('renders a link with the given href', () => {
    render(
      <MemoryRouter>
        <RowLink to="/submissions/abc123">Row content</RowLink>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Row content' });
    expect(link).toHaveAttribute('href', '/submissions/abc123');
  });

  it('renders children as the accessible name', () => {
    render(
      <MemoryRouter>
        <RowLink to="/x">
          <span>Student One</span>
        </RowLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Student One' })).toBeInTheDocument();
  });

  it('applies the className prop', () => {
    render(
      <MemoryRouter>
        <RowLink to="/x" className="custom-row-link">
          content
        </RowLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'content' })).toHaveClass('custom-row-link');
  });

  it('has a focus-visible ring class', () => {
    render(
      <MemoryRouter>
        <RowLink to="/x">content</RowLink>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'content' });
    expect(link.className).toContain('focus-visible:ring-2');
    expect(link.className).toContain('focus-visible:ring-ring');
  });
});
