import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteLoading } from './RouteLoading.js';

describe('RouteLoading', () => {
  it('renders a status region with the default label', () => {
    render(<RouteLoading />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Loading…');
  });

  it('renders a status region with a custom label', () => {
    render(<RouteLoading label="Fetching cohort…" />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Fetching cohort…');
  });
});
