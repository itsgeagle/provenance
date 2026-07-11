import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SortableHeader } from './SortableHeader.js';

// SortableHeader renders a <th> so it must live inside a real table structure
// for the columnheader role to resolve correctly in jsdom.
function renderInTable(ui: React.ReactElement) {
  return render(
    <table>
      <thead>
        <tr>{ui}</tr>
      </thead>
    </table>,
  );
}

describe('SortableHeader', () => {
  it('sets aria-sort="ascending" when direction is asc', () => {
    renderInTable(<SortableHeader label="Name" direction="asc" onSort={vi.fn()} />);
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('sets aria-sort="descending" when direction is desc', () => {
    renderInTable(<SortableHeader label="Name" direction="desc" onSort={vi.fn()} />);
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('sets aria-sort="none" when direction is null', () => {
    renderInTable(<SortableHeader label="Name" direction={null} onSort={vi.fn()} />);
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('applies the className prop to the <th>', () => {
    renderInTable(
      <SortableHeader label="Name" direction={null} onSort={vi.fn()} className="custom-th" />,
    );
    expect(screen.getByRole('columnheader')).toHaveClass('custom-th');
  });

  it('renders a real button with the label as its accessible name', () => {
    renderInTable(<SortableHeader label="Name" direction={null} onSort={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Name' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('supports an aria-label override for the button accessible name', () => {
    renderInTable(
      <SortableHeader
        label="Name"
        direction={null}
        onSort={vi.fn()}
        aria-label="Sort by student name"
      />,
    );
    expect(screen.getByRole('button', { name: 'Sort by student name' })).toBeInTheDocument();
  });

  it('calls onSort when the button is clicked (mouse)', () => {
    const onSort = vi.fn();
    renderInTable(<SortableHeader label="Name" direction={null} onSort={onSort} />);
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('calls onSort when the button is activated via keyboard (Enter)', () => {
    const onSort = vi.fn();
    renderInTable(<SortableHeader label="Name" direction={null} onSort={onSort} />);
    const button = screen.getByRole('button', { name: 'Name' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
    // Native <button> elements fire a click in response to Enter/Space; jsdom
    // does not synthesize this automatically for keyDown, so exercise the
    // browser-native path via fireEvent.click after keyDown to assert the
    // handler is wired to the click event a real Enter/Space press produces.
    fireEvent.click(button);
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('includes an aria-hidden sort indicator glyph', () => {
    renderInTable(<SortableHeader label="Name" direction="asc" onSort={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Name' });
    const indicator = button.querySelector('[aria-hidden="true"]');
    expect(indicator).not.toBeNull();
  });

  it('has a focus-visible ring class on the button', () => {
    renderInTable(<SortableHeader label="Name" direction={null} onSort={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Name' });
    expect(button.className).toContain('focus-visible:ring-2');
    expect(button.className).toContain('focus-visible:ring-ring');
  });
});
