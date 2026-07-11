import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusRegion } from './StatusRegion.js';

describe('StatusRegion', () => {
  it('renders a polite status live region with the given text', () => {
    render(<StatusRegion>Loading…</StatusRegion>);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Loading…');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('applies the className prop', () => {
    render(<StatusRegion className="custom-class">Hi</StatusRegion>);
    expect(screen.getByRole('status')).toHaveClass('custom-class');
  });
});
