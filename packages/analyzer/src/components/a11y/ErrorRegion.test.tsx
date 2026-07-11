import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorRegion } from './ErrorRegion.js';

describe('ErrorRegion', () => {
  it('renders an alert region with the given text', () => {
    render(<ErrorRegion>Something went wrong</ErrorRegion>);
    const region = screen.getByRole('alert');
    expect(region).toHaveTextContent('Something went wrong');
  });

  it('applies the className prop', () => {
    render(<ErrorRegion className="custom-class">Oops</ErrorRegion>);
    expect(screen.getByRole('alert')).toHaveClass('custom-class');
  });
});
