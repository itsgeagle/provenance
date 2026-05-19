import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityChip } from './SeverityChip';

describe('SeverityChip', () => {
  it('renders info severity with gray classes', () => {
    render(<SeverityChip severity="info" />);
    const chip = screen.getByTestId('severity-chip-info');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('INFO');
    expect(chip.className).toContain('bg-gray-100');
    expect(chip.className).toContain('text-gray-700');
  });

  it('renders low severity with blue classes', () => {
    render(<SeverityChip severity="low" />);
    const chip = screen.getByTestId('severity-chip-low');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('LOW');
    expect(chip.className).toContain('bg-blue-100');
    expect(chip.className).toContain('text-blue-700');
  });

  it('renders medium severity with amber classes', () => {
    render(<SeverityChip severity="medium" />);
    const chip = screen.getByTestId('severity-chip-medium');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('MEDIUM');
    expect(chip.className).toContain('bg-amber-100');
    expect(chip.className).toContain('text-amber-700');
  });

  it('renders high severity with red classes', () => {
    render(<SeverityChip severity="high" />);
    const chip = screen.getByTestId('severity-chip-high');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('HIGH');
    expect(chip.className).toContain('bg-red-100');
    expect(chip.className).toContain('text-red-700');
  });
});
