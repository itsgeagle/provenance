/**
 * Smoke tests for dropdown-menu shadcn primitive.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './dropdown-menu.js';

describe('DropdownMenu primitives', () => {
  it('renders a trigger button', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="trigger">Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByTestId('trigger')).toBeInTheDocument();
    expect(screen.getByText('Open Menu')).toBeInTheDocument();
  });

  it('gives DropdownMenuItem a visible keyboard-focus ring independent of focus:bg-accent', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = screen.getByText('Item 1');
    expect(item.className).toContain('focus:ring-2');
    expect(item.className).toContain('focus:ring-ring');
    expect(item.className).toContain('focus:ring-inset');
  });

  it('renders DropdownMenuLabel', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Filter by kind</DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByText('Filter by kind')).toBeInTheDocument();
  });

  it('renders DropdownMenuCheckboxItem when menu is open', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={true}>paste</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={false}>doc.change</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByText('paste')).toBeInTheDocument();
    expect(screen.getByText('doc.change')).toBeInTheDocument();
  });

  it('renders DropdownMenuSeparator when menu is open', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Item 2</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    // DropdownMenuContent is portaled to document.body, so query the whole doc.
    const separator = document.body.querySelector('[role="separator"]');
    expect(separator).toBeInTheDocument();
  });
});
