/**
 * Tests for BundleContext / useBundle / BundleProvider.
 *
 * Uses the buildTestBundle helper (same as Phase 1–4 tests) to create a
 * structurally-valid bundle File without needing a real recorder session.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from './BundleContext.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// Wire SHA-512 override (same as build-test-bundle.ts) so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Helper: component that reads context values into the DOM for assertions.
// ---------------------------------------------------------------------------

function StatusDisplay() {
  const { bundles, index, validationReport, flags, status, loadingStage, loadError } = useBundle();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="bundle-count">{bundles.length}</span>
      <span data-testid="has-index">{index !== null ? 'yes' : 'no'}</span>
      <span data-testid="has-report">{validationReport !== null ? 'yes' : 'no'}</span>
      <span data-testid="flag-count">{flags.length}</span>
      <span data-testid="loading-stage">{loadingStage ?? 'null'}</span>
      <span data-testid="load-error">{loadError?.kind ?? 'null'}</span>
    </div>
  );
}

function LoadTrigger({ file }: { file: File }) {
  const { loadBundleFile } = useBundle();
  return (
    <button
      data-testid="load-btn"
      onClick={() => {
        void loadBundleFile(file);
      }}
    >
      load
    </button>
  );
}

function ClearTrigger() {
  const { clearBundle } = useBundle();
  return (
    <button data-testid="clear-btn" onClick={clearBundle}>
      clear
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useBundle', () => {
  it('throws when called outside <BundleProvider>', () => {
    // Suppress the expected React error boundary console.error call.
    const err = console.error;
    console.error = () => {};

    function NoBundleConsumer() {
      useBundle(); // should throw
      return null;
    }

    expect(() =>
      render(
        <MemoryRouter>
          <NoBundleConsumer />
        </MemoryRouter>,
      ),
    ).toThrow('useBundle must be called inside <BundleProvider>');

    console.error = err;
  });
});

describe('BundleProvider', () => {
  it('exposes initial idle state', () => {
    render(
      <MemoryRouter>
        <BundleProvider>
          <StatusDisplay />
        </BundleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(screen.getByTestId('bundle-count').textContent).toBe('0');
    expect(screen.getByTestId('has-index').textContent).toBe('no');
    expect(screen.getByTestId('has-report').textContent).toBe('no');
    expect(screen.getByTestId('flag-count').textContent).toBe('0');
    expect(screen.getByTestId('loading-stage').textContent).toBe('null');
    expect(screen.getByTestId('load-error').textContent).toBe('null');
  });

  it('transitions to loaded after loadBundleFile with a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const file = new File([blob], 'test-bundle.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <StatusDisplay />
          <LoadTrigger file={file} />
        </BundleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('status').textContent).toBe('idle');

    act(() => {
      screen.getByTestId('load-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    expect(screen.getByTestId('bundle-count').textContent).toBe('1');
    expect(screen.getByTestId('has-index').textContent).toBe('yes');
    expect(screen.getByTestId('has-report').textContent).toBe('yes');
    expect(screen.getByTestId('loading-stage').textContent).toBe('null');
    expect(screen.getByTestId('load-error').textContent).toBe('null');
  });

  it('transitions to error on an invalid file', async () => {
    const file = new File(['not a zip'], 'bad.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <StatusDisplay />
          <LoadTrigger file={file} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('error');
    });

    expect(screen.getByTestId('bundle-count').textContent).toBe('0');
    expect(screen.getByTestId('load-error').textContent).not.toBe('null');
  });

  it('clearBundle resets state to idle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'test-bundle.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <StatusDisplay />
          <LoadTrigger file={file} />
          <ClearTrigger />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    act(() => {
      screen.getByTestId('clear-btn').click();
    });

    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(screen.getByTestId('bundle-count').textContent).toBe('0');
    expect(screen.getByTestId('has-index').textContent).toBe('no');
    expect(screen.getByTestId('has-report').textContent).toBe('no');
    expect(screen.getByTestId('flag-count').textContent).toBe('0');
    expect(screen.getByTestId('load-error').textContent).toBe('null');
  });
});
