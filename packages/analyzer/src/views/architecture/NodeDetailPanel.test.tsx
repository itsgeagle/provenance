import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodeDetailPanel } from './NodeDetailPanel.js';

describe('NodeDetailPanel', () => {
  it('renders nothing when no node is selected', () => {
    const { container } = render(
      <NodeDetailPanel diagramId="master" node={null} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders title, body, invariant and links for a known node', () => {
    render(<NodeDetailPanel diagramId="master" node="chain" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /hash chain/i })).toBeInTheDocument();
    expect(screen.getByText(/every log-producing path goes through it/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /hash-chain\.ts/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('packages/log-core'));
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('falls back gracefully for a node with no authored detail', () => {
    render(<NodeDetailPanel diagramId="master" node="stu" onClose={vi.fn()} />);
    expect(screen.getByText(/no additional detail/i)).toBeInTheDocument();
  });

  it('closes on the close button', () => {
    const onClose = vi.fn();
    render(<NodeDetailPanel diagramId="master" node="chain" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
