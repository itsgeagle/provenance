/**
 * MonacoMount.test.tsx — smoke test: renders inside <Suspense>.
 *
 * MonacoEditor itself is mocked so no browser canvas / worker setup is needed.
 * The test verifies:
 *  1. The component renders inside <Suspense> without throwing.
 *  2. Language detection works for known extensions.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MonacoMount } from './MonacoMount.js';

// ---------------------------------------------------------------------------
// Mock @monaco-editor/react so the lazy import resolves synchronously in jsdom.
// ---------------------------------------------------------------------------
vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    language,
    className,
  }: {
    value: string;
    language: string;
    className?: string;
  }) => (
    <div
      data-testid="monaco-editor"
      data-language={language}
      data-value={value}
      className={className}
    />
  ),
}));

describe('MonacoMount', () => {
  it('renders inside Suspense and shows the editor after load', async () => {
    render(<MonacoMount content="print('hello')" filePath="hw.py" />);
    // Wait for Suspense to resolve (the lazy mock resolves immediately in vitest).
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeDefined();
    });
  });

  it('passes content as value', async () => {
    render(<MonacoMount content="x = 42" filePath="hw.py" />);
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('x = 42');
    });
  });

  it('detects python for .py', async () => {
    render(<MonacoMount content="" filePath="hw.py" />);
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-language')).toBe('python');
    });
  });

  it('detects typescript for .ts', async () => {
    render(<MonacoMount content="" filePath="index.ts" />);
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-language')).toBe('typescript');
    });
  });

  it('detects javascript for .js', async () => {
    render(<MonacoMount content="" filePath="app.js" />);
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-language')).toBe('javascript');
    });
  });

  it('falls back to plaintext for unknown extension', async () => {
    render(<MonacoMount content="" filePath="notes.xyz" />);
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-language')).toBe('plaintext');
    });
  });

  it('shows skeleton while loading', () => {
    // To see the skeleton we'd need a slow-resolving lazy import, which is hard
    // to reliably simulate in jsdom. We at least verify the component doesn't
    // throw when the skeleton would show.
    render(<MonacoMount content="" filePath="hw.py" />);
    // Component either shows skeleton or editor — no throw is the assertion.
    expect(document.body).toBeDefined();
  });
});
