import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Progress } from './progress.js';

describe('Progress', () => {
  it('renders with aria role', () => {
    render(<Progress value={60} aria-label="progress" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
