import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiagramFrame } from './DiagramFrame.js';

const SVG = `<svg viewBox="0 0 10 10" width="10pt" height="10pt">
  <g id="node1" class="node"><title>chain</title><polygon class="f-fmt s-fmt"/></g>
</svg>`;

describe('DiagramFrame', () => {
  it('shows the title and no panel until a node is picked', () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    expect(screen.getByText('End-to-end')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /node details/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel when a node is clicked', () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    fireEvent.click(screen.getByText('chain').closest('g')!);
    expect(screen.getByRole('region', { name: /node details/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /hash chain/i })).toBeInTheDocument();
  });

  it('opens a fullscreen dialog', () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    fireEvent.click(screen.getByRole('button', { name: /full screen/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
