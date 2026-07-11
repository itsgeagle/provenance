import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteError } from './RouteError.js';

describe('RouteError', () => {
  it('renders an alert region with the given message', () => {
    render(<RouteError message="Failed to load. Please refresh." />);
    const region = screen.getByRole('alert');
    expect(region).toHaveTextContent('Failed to load. Please refresh.');
  });
});
