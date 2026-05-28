/**
 * Combobox tests — focused on the behaviors we rely on in AttachModal:
 *   - opens on focus, filters by typed query (client mode)
 *   - mouseDown on an option commits selection and closes the popup
 *   - controlled query via onQueryChange (server mode)
 *   - renders the warn badge for conflicting options
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Combobox, type ComboboxOption } from './combobox.js';

const OPTIONS: ComboboxOption[] = [
  { value: 'a', label: 'Alpha', secondary: 'first' },
  { value: 'b', label: 'Bravo', secondary: 'second' },
  { value: 'c', label: 'Charlie', secondary: 'third', badge: 'taken', badgeTone: 'warn' },
];

describe('Combobox', () => {
  it('opens on focus and filters by typed query (client mode)', () => {
    const onChange = vi.fn();
    render(
      <Combobox
        value=""
        onChange={onChange}
        options={OPTIONS}
        data-testid="cbx"
        placeholder="search"
      />,
    );

    const input = screen.getByPlaceholderText('search') as HTMLInputElement;
    fireEvent.focus(input);

    // All three options visible after focus.
    expect(screen.getByTestId('combobox-option-a')).toBeInTheDocument();
    expect(screen.getByTestId('combobox-option-b')).toBeInTheDocument();
    expect(screen.getByTestId('combobox-option-c')).toBeInTheDocument();

    // Filter narrows down.
    fireEvent.change(input, { target: { value: 'cha' } });
    expect(screen.queryByTestId('combobox-option-a')).toBeNull();
    expect(screen.queryByTestId('combobox-option-b')).toBeNull();
    expect(screen.getByTestId('combobox-option-c')).toBeInTheDocument();
  });

  it('selects an option on mouseDown and reports the value', () => {
    const onChange = vi.fn();
    render(<Combobox value="" onChange={onChange} options={OPTIONS} placeholder="search" />);

    const input = screen.getByPlaceholderText('search') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByTestId('combobox-option-b'));

    expect(onChange).toHaveBeenCalledWith('b');
    // Popup closes — option no longer in the tree.
    expect(screen.queryByTestId('combobox-option-b')).toBeNull();
  });

  it('routes typing to onQueryChange in controlled mode', () => {
    const onQueryChange = vi.fn();
    render(
      <Combobox
        value=""
        onChange={() => {}}
        options={OPTIONS}
        filter="none"
        query=""
        onQueryChange={onQueryChange}
        placeholder="search"
      />,
    );

    const input = screen.getByPlaceholderText('search') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'al' } });
    expect(onQueryChange).toHaveBeenCalledWith('al');
  });

  it('renders the warn badge for marked options', () => {
    render(<Combobox value="" onChange={() => {}} options={OPTIONS} placeholder="search" />);
    fireEvent.focus(screen.getByPlaceholderText('search'));
    expect(screen.getByText('taken')).toBeInTheDocument();
  });
});
