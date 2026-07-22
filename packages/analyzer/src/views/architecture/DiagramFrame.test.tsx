import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DiagramFrame } from './DiagramFrame.js';
import { ArchitectureTheme } from './ArchitectureTheme.js';

// DiagramFrame reads useArchTheme() to re-stamp the resolved theme onto the
// fullscreen portal, so every render must sit inside the provider — as it does
// in production (ArchitectureView wraps the whole page).
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

function renderFramed(ui: React.ReactElement) {
  return render(<ArchitectureTheme>{ui}</ArchitectureTheme>);
}

const SVG = `<svg viewBox="0 0 10 10" width="10pt" height="10pt">
  <g id="node1" class="node"><title>chain</title><polygon class="f-fmt s-fmt"/></g>
</svg>`;

describe('DiagramFrame', () => {
  it('shows the title and no panel until a node is picked', () => {
    renderFramed(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    expect(screen.getByText('End-to-end')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /node details/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel when a node is clicked', () => {
    renderFramed(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    fireEvent.click(screen.getByText('chain').closest('g')!);
    expect(screen.getByRole('region', { name: /node details/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /hash chain/i })).toBeInTheDocument();
  });

  it('opens a fullscreen dialog', () => {
    renderFramed(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    fireEvent.click(screen.getByRole('button', { name: /full screen/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
