import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Plate } from './Plate.js';
import { PLATES } from './layout.js';

const plate = PLATES[0]!; // "master"

describe('Plate', () => {
  it('renders the plate number, title, and caption', () => {
    const { container } = render(
      <Plate
        plate={plate}
        active={false}
        dim={false}
        selectedNode={null}
        onActivateNode={() => {}}
      />,
    );
    expect(container.querySelector('.arch-plate-no')).toHaveTextContent(plate.no);
    expect(container.querySelector('.arch-plate-title')).toHaveTextContent(plate.title);
    expect(container.querySelector('.arch-plate-cap')).toHaveTextContent(plate.caption);
  });

  it('stamps role, tabindex, and aria-label on every injected g.node', () => {
    const { container } = render(
      <Plate
        plate={plate}
        active={false}
        dim={false}
        selectedNode={null}
        onActivateNode={() => {}}
      />,
    );
    const allNodes = container.querySelectorAll('g.node');
    const stamped = container.querySelectorAll('g.node[role="button"]');
    expect(allNodes.length).toBeGreaterThan(0);
    expect(stamped.length).toBe(allNodes.length);
    stamped.forEach((g) => {
      expect(g.getAttribute('tabindex')).toBe('0');
      expect(g.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('Enter on a g.node calls onActivateNode with the plate and node name', () => {
    const onActivateNode = vi.fn();
    const { container } = render(
      <Plate
        plate={plate}
        active={false}
        dim={false}
        selectedNode={null}
        onActivateNode={onActivateNode}
      />,
    );
    const g = container.querySelector('g.node[aria-label^="chain"]');
    expect(g).not.toBeNull();
    fireEvent.keyDown(g!, { key: 'Enter' });
    expect(onActivateNode).toHaveBeenCalledWith('master', 'chain');
  });

  it('marks the selected node with data-selected="true"', () => {
    const { container } = render(
      <Plate
        plate={plate}
        active={false}
        dim={false}
        selectedNode="chain"
        onActivateNode={() => {}}
      />,
    );
    const selected = container.querySelector('g.node[aria-label^="chain"]');
    expect(selected).toHaveAttribute('data-selected', 'true');
    const others = [...container.querySelectorAll('g.node')].filter((g) => g !== selected);
    others.forEach((g) => expect(g).not.toHaveAttribute('data-selected'));
  });
});
