import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodeDetailPanel } from './NodeDetailPanel.js';

describe('NodeDetailPanel', () => {
  it('renders nothing when node is null', () => {
    const { container } = render(
      <NodeDetailPanel diagram="master" node={null} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders title, address, and a source link for a node with authored detail', () => {
    render(<NodeDetailPanel diagram="master" node="chain" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Hash chain' })).toBeInTheDocument();
    // address is split across a <b> and the node name; check the region text content.
    expect(screen.getByRole('region', { name: 'Node details' })).toHaveTextContent('master:chain');
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((l) => l.getAttribute('rel') === 'noreferrer')).toBe(true);
  });

  it('renders the plain-label fallback for a node with no authored detail', () => {
    // "stu" is in master's NO_DETAIL set (see content/nodes/master.ts).
    render(<NodeDetailPanel diagram="master" node="stu" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'stu' })).toBeInTheDocument();
    expect(screen.getByText(/plain label/i)).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<NodeDetailPanel diagram="master" node="chain" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close details/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
