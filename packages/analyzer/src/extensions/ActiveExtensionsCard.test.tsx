import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveExtensionsCard } from './ActiveExtensionsCard.js';
import type { ActiveExtension } from './collect-active-extensions.js';

describe('ActiveExtensionsCard', () => {
  it('renders the empty state when there are no extensions', () => {
    render(<ActiveExtensionsCard extensions={[]} />);
    expect(screen.getByTestId('active-extensions-empty')).toHaveTextContent(
      'No third-party extensions were active.',
    );
  });

  it('lists each extension with its id and version', () => {
    const extensions: ActiveExtension[] = [
      { id: 'esbenp.prettier-vscode', version: '1.2.0', isAi: false },
    ];
    render(<ActiveExtensionsCard extensions={extensions} />);
    const row = screen.getByTestId('extension-row-esbenp.prettier-vscode');
    expect(row).toHaveTextContent('esbenp.prettier-vscode');
    expect(row).toHaveTextContent('1.2.0');
    expect(screen.queryByTestId('extension-ai-badge-esbenp.prettier-vscode')).toBeNull();
  });

  it('renders an AI badge with a reason tooltip for AI extensions', () => {
    const extensions: ActiveExtension[] = [
      { id: 'GitHub.copilot', version: '1.0.0', isAi: true, aiReason: 'known AI extension' },
    ];
    render(<ActiveExtensionsCard extensions={extensions} />);
    const badge = screen.getByTestId('extension-ai-badge-GitHub.copilot');
    expect(badge).toHaveTextContent('AI');
    expect(badge).toHaveAttribute('title', 'known AI extension');
  });
});
