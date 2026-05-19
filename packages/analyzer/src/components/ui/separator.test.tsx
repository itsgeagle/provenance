/**
 * Smoke tests for separator shadcn primitive.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Separator } from './separator.js';

describe('Separator primitive', () => {
  it('renders a horizontal separator by default', () => {
    render(<Separator data-testid="sep" />);
    const sep = screen.getByTestId('sep');
    expect(sep).toBeInTheDocument();
  });

  it('renders with horizontal orientation', () => {
    const { container } = render(<Separator orientation="horizontal" />);
    const sep = container.firstChild as HTMLElement;
    expect(sep).toBeInTheDocument();
    // Radix sets aria-orientation for non-decorative separators;
    // for decorative (default), the element still renders.
    expect(sep.tagName).toBe('DIV');
  });

  it('renders with vertical orientation', () => {
    const { container } = render(<Separator orientation="vertical" />);
    const sep = container.firstChild as HTMLElement;
    expect(sep).toBeInTheDocument();
  });

  it('accepts className', () => {
    render(<Separator className="my-separator" data-testid="cls-sep" />);
    expect(screen.getByTestId('cls-sep')).toHaveClass('my-separator');
  });
});
