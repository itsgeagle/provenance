/**
 * Phase 11 tests for BundleContext multi-bundle behaviour.
 *
 * Tests verified here:
 *   - loadBundleFiles with two valid blobs → bundles.length === 2
 *   - Per-bundle indices isolated (each has its own EventIndex)
 *   - selectedBundleId defaults to the first bundle loaded
 *   - selectBundle switches the derived scalar accessors (index/validationReport/flags)
 *   - partialLoadErrors populated when some files fail
 */

import { describe, it, expect } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from './BundleContext.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function MultiStatusDisplay() {
  const { bundles, selectedBundleId, index, validationReport, flags, status, partialLoadErrors } =
    useBundle();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="bundle-count">{bundles.length}</span>
      <span data-testid="selected-id">{selectedBundleId ?? 'null'}</span>
      <span data-testid="has-index">{index !== null ? 'yes' : 'no'}</span>
      <span data-testid="has-report">{validationReport !== null ? 'yes' : 'no'}</span>
      <span data-testid="flag-count">{flags.length}</span>
      <span data-testid="partial-error-count">{partialLoadErrors.length}</span>
    </div>
  );
}

function LoadFilesTrigger({ files }: { files: File[] }) {
  const { loadBundleFiles } = useBundle();
  return (
    <button
      data-testid="load-files-btn"
      onClick={() => {
        void loadBundleFiles(files);
      }}
    >
      load files
    </button>
  );
}

function BundleIdDisplay() {
  const { bundles } = useBundle();
  return (
    <div>
      {bundles.map((b) => (
        <span key={b.id} data-testid={`bundle-id-${b.sourceFilename}`}>
          {b.id}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BundleProvider multi-bundle (Phase 11)', () => {
  it('loads two bundles and exposes both via bundles[]', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const file1 = new File([blob1], 'hw1.zip', { type: 'application/zip' });
    const file2 = new File([blob2], 'hw2.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <MultiStatusDisplay />
          <LoadFilesTrigger files={[file1, file2]} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    expect(screen.getByTestId('bundle-count').textContent).toBe('2');
    expect(screen.getByTestId('has-index').textContent).toBe('yes');
    expect(screen.getByTestId('has-report').textContent).toBe('yes');
  });

  it('selectedBundleId defaults to the first bundle loaded', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const file = new File([blob], 'first.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <MultiStatusDisplay />
          <BundleIdDisplay />
          <LoadFilesTrigger files={[file]} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    const firstBundleId = screen.getByTestId('bundle-id-first.zip').textContent ?? '';
    expect(firstBundleId.length).toBeGreaterThan(0);
    expect(screen.getByTestId('selected-id').textContent).toBe(firstBundleId);
  });

  it('per-bundle indices are isolated (each bundle has independent EventIndex)', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const file1 = new File([blob1], 'a.zip', { type: 'application/zip' });
    const file2 = new File([blob2], 'b.zip', { type: 'application/zip' });

    let capturedIndicesSize = 0;
    function IndicesChecker() {
      const { indicesByBundle } = useBundle();
      capturedIndicesSize = indicesByBundle.size;
      return null;
    }

    render(
      <MemoryRouter>
        <BundleProvider>
          <MultiStatusDisplay />
          <IndicesChecker />
          <LoadFilesTrigger files={[file1, file2]} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    // Both bundles should have their own entry in indicesByBundle.
    expect(capturedIndicesSize).toBe(2);
  });

  it('selectBundle switches the derived scalar accessors', async () => {
    const { blob: blob1 } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const { blob: blob2 } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const file1 = new File([blob1], 'a.zip', { type: 'application/zip' });
    const file2 = new File([blob2], 'b.zip', { type: 'application/zip' });

    /**
     * Renders a select button for each bundle in load order.
     * Clicking select-{idx} calls selectBundle(bundles[idx].id).
     */
    function SelectButtons() {
      const { bundles, selectBundle } = useBundle();
      return (
        <div>
          {bundles.map((b, idx) => (
            <button key={b.id} data-testid={`select-${idx}`} onClick={() => selectBundle(b.id)}>
              select {idx}
            </button>
          ))}
        </div>
      );
    }

    /** Captures the id of bundles[1] (b.zip) once both are loaded. */
    function Bundle1IdDisplay() {
      const { bundles } = useBundle();
      const b2 = bundles[1];
      return b2 ? <span data-testid="bundle1-id">{b2.id}</span> : null;
    }

    render(
      <MemoryRouter>
        <BundleProvider>
          <MultiStatusDisplay />
          <SelectButtons />
          <Bundle1IdDisplay />
          <LoadFilesTrigger files={[file1, file2]} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    // Before selectBundle: selected defaults to first bundle (a.zip, idx 0).
    // The derived `index` accessor must be non-null (a.zip was indexed).
    expect(screen.getByTestId('has-index').textContent).toBe('yes');
    expect(screen.getByTestId('has-report').textContent).toBe('yes');

    const bundle1Id = screen.getByTestId('bundle1-id').textContent ?? '';
    expect(bundle1Id.length).toBeGreaterThan(0);

    // selected-id must not already be the second bundle's id.
    expect(screen.getByTestId('selected-id').textContent).not.toBe(bundle1Id);

    // Click the select button for bundles[1] (b.zip) — this calls selectBundle(b.zip.id).
    act(() => {
      screen.getByTestId('select-1').click();
    });

    // After selectBundle: selected-id must now be the second bundle.
    await waitFor(() => {
      expect(screen.getByTestId('selected-id').textContent).toBe(bundle1Id);
    });

    // The derived scalar `index` should remain non-null (b.zip also has an index).
    expect(screen.getByTestId('has-index').textContent).toBe('yes');
    expect(screen.getByTestId('has-report').textContent).toBe('yes');
  });

  it('partialLoadErrors populated when one file is invalid', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const validFile = new File([blob], 'good.zip', { type: 'application/zip' });
    const badFile = new File(['garbage'], 'bad.zip', { type: 'application/zip' });

    render(
      <MemoryRouter>
        <BundleProvider>
          <MultiStatusDisplay />
          <LoadFilesTrigger files={[validFile, badFile]} />
        </BundleProvider>
      </MemoryRouter>,
    );

    act(() => {
      screen.getByTestId('load-files-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loaded');
    });

    // One bundle loaded, one partial error.
    expect(screen.getByTestId('bundle-count').textContent).toBe('1');
    expect(screen.getByTestId('partial-error-count').textContent).toBe('1');
  });
});
