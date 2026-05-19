import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './badge.js';

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>3 sessions</Badge>);
    expect(screen.getByText('3 sessions')).toBeInTheDocument();
  });

  it('applies variant class', () => {
    render(<Badge variant="destructive" data-testid="badge">!</Badge>);
    expect(screen.getByTestId('badge')).toHaveClass('bg-destructive');
  });

  it('applies custom className', () => {
    render(<Badge className="extra" data-testid="badge">x</Badge>);
    expect(screen.getByTestId('badge')).toHaveClass('extra');
  });
});
