import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DiagramCanvas } from './DiagramCanvas.js';

const SVG = `<svg viewBox="0 0 100 100" width="100pt" height="100pt">
  <g id="node1" class="node"><title>dedup</title><polygon class="f-srv s-srv"/></g>
  <g id="node2" class="node"><title>strip</title><polygon class="f-rec s-rec"/></g>
</svg>`;

describe('DiagramCanvas', () => {
  it('selects the node whose title was clicked', () => {
    const onSelect = vi.fn();
    render(<DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('strip').closest('g')!);
    expect(onSelect).toHaveBeenCalledWith('strip');
  });

  it('marks the selected node for styling', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected="dedup" onSelect={vi.fn()} />,
    );
    const sel = container.querySelector('g.node[data-selected="true"]');
    expect(sel?.querySelector('title')?.textContent).toBe('dedup');
  });

  it('zooms in and resets', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={vi.fn()} />,
    );
    const stage = () => container.querySelector('.arch-stage') as HTMLElement;
    const before = stage().style.transform;
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(stage().style.transform).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: /reset view/i }));
    expect(stage().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('is keyboard operable', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={vi.fn()} />,
    );
    const view = container.querySelector('.arch-viewport') as HTMLElement;
    view.focus();
    fireEvent.keyDown(view, { key: 'ArrowRight' });
    expect((container.querySelector('.arch-stage') as HTMLElement).style.transform).toContain(
      'translate(-40px, 0px)',
    );
  });
});
