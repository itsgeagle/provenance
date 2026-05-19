import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScrollArea } from './scroll-area.js';

describe('ScrollArea', () => {
  it('renders its children', () => {
    render(<ScrollArea>scroll content</ScrollArea>);
    expect(screen.getByText('scroll content')).toBeInTheDocument();
  });
});
