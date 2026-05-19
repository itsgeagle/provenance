/**
 * Smoke tests for input shadcn primitive.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './input.js';

describe('Input primitive', () => {
  it('renders an input element', () => {
    render(<Input data-testid="test-input" placeholder="Enter value" />);
    const input = screen.getByTestId('test-input');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('renders with placeholder', () => {
    render(<Input placeholder="Start (ms)" />);
    expect(screen.getByPlaceholderText('Start (ms)')).toBeInTheDocument();
  });

  it('forwards type prop', () => {
    render(<Input type="number" data-testid="num-input" />);
    const input = screen.getByTestId('num-input');
    expect(input).toHaveAttribute('type', 'number');
  });

  it('fires onChange', () => {
    let value = '';
    render(
      <Input
        data-testid="changeable"
        onChange={(e) => {
          value = e.target.value;
        }}
      />,
    );
    fireEvent.change(screen.getByTestId('changeable'), { target: { value: '1000' } });
    expect(value).toBe('1000');
  });

  it('applies className', () => {
    render(<Input className="custom-class" data-testid="styled-input" />);
    expect(screen.getByTestId('styled-input')).toHaveClass('custom-class');
  });

  it('is disabled when disabled prop is set', () => {
    render(<Input disabled data-testid="disabled-input" />);
    expect(screen.getByTestId('disabled-input')).toBeDisabled();
  });
});
