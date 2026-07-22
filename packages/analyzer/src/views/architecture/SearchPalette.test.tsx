import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SearchPalette } from './SearchPalette.js';

// jsdom does not implement Element.scrollIntoView; the component calls it to
// keep the selected hit visible as the arrow keys move the selection.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SearchPalette', () => {
  it('renders a focused search input', () => {
    render(<SearchPalette onPick={() => {}} onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: /search plates and nodes/i });
    expect(input).toHaveFocus();
  });

  it('shows hits for a query and marks the first one selected', () => {
    const { container } = render(<SearchPalette onPick={() => {}} onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: /search plates and nodes/i });
    fireEvent.change(input, { target: { value: 'paste' } });

    const hits = container.querySelectorAll('.arch-hit');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toHaveClass('sel');
    expect(container.querySelectorAll('.arch-hit.sel')).toHaveLength(1);
  });

  it('ArrowDown then Enter picks the second hit', () => {
    const onPick = vi.fn();
    render(<SearchPalette onPick={onPick} onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: /search plates and nodes/i });
    fireEvent.change(input, { target: { value: 'paste' } });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).toHaveBeenCalledTimes(1);
    const picked = onPick.mock.calls[0]![0];
    expect(typeof picked.addr).toBe('string');
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<SearchPalette onPick={() => {}} onClose={onClose} />);
    const input = screen.getByRole('textbox', { name: /search plates and nodes/i });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a hit calls onPick', () => {
    const onPick = vi.fn();
    const { container } = render(<SearchPalette onPick={onPick} onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: /search plates and nodes/i });
    fireEvent.change(input, { target: { value: 'paste' } });

    const hit = container.querySelector('.arch-hit');
    expect(hit).not.toBeNull();
    fireEvent.click(hit!);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
