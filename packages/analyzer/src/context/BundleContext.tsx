/**
 * BundleContext — provides loaded bundle state to all routes.
 *
 * Design notes:
 * - `bundles` is plural-shaped from v1 (always length 1 in v1) so Phase 11
 *   only changes the loader, not consumers.
 * - `loadingStage` advances synchronously between pipeline steps so
 *   LoadingPanel can display coarse progress without a full event emitter.
 * - The provider must sit inside <BrowserRouter> (done in main.tsx) and wraps
 *   <Routes> inside App.tsx.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildIndex } from '../index/build-index.js';
import { runValidation } from '../validation/run-validation.js';
import { runHeuristics } from '../heuristics/run-heuristics.js';
import type { Bundle, LoaderError, SessionParseError } from '../loader/types.js';
import type { EventIndex } from '../index/event-index.js';
import type { ValidationReport } from '../validation/check-types.js';
import type { Flag } from '../heuristics/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadingStage = 'unzip' | 'parse' | 'index' | 'validate' | 'heuristics' | null;

export type BundleContextValue = {
  /** Plural-shaped; v1 always has length 0 or 1. */
  bundles: Bundle[];
  index: EventIndex | null;
  validationReport: ValidationReport | null;
  flags: Flag[];
  status: 'idle' | 'loading' | 'loaded' | 'error';
  loadingStage: LoadingStage;
  /** The loader error, set when status === 'error'. */
  loadError: LoaderError | SessionParseError | null;
  /** Load a bundle from a File (e.g. from the drop zone or file picker). */
  loadBundleFile(file: File): Promise<void>;
  /** Reset state back to idle; navigate to /load. */
  clearBundle(): void;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const BundleContext = createContext<BundleContextValue | null>(null);

/**
 * Read the bundle context.
 *
 * Throws if called outside <BundleProvider> so mis-wired components are
 * caught immediately in development rather than silently rendering blank.
 */
export function useBundle(): BundleContextValue {
  const ctx = useContext(BundleContext);
  if (ctx === null) {
    throw new Error('useBundle must be called inside <BundleProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function BundleProvider({ children }: { children: ReactNode }) {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [index, setIndex] = useState<EventIndex | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [status, setStatus] = useState<BundleContextValue['status']>('idle');
  const [loadingStage, setLoadingStage] = useState<LoadingStage>(null);
  const [loadError, setLoadError] = useState<LoaderError | SessionParseError | null>(null);

  const loadBundleFile = useCallback(async (file: File) => {
    setStatus('loading');
    setLoadError(null);
    setLoadingStage('unzip');

    try {
      // Step 1 + 2: unzip + parse (loadBundle covers both stages).
      const bundleResult = await loadBundle(file, file.name);
      if (!bundleResult.ok) {
        setLoadError(bundleResult.error);
        setStatus('error');
        setLoadingStage(null);
        return;
      }
      const bundle = bundleResult.value;

      // Step 2 stage label: parsing is complete inside loadBundle; advance here.
      setLoadingStage('index');

      // Step 3: build index (synchronous, O(N log N)).
      const idx = buildIndex(bundle);

      setLoadingStage('validate');

      // Step 4: validation (async — verify-manifest-sig uses WebCrypto).
      const report = await runValidation(bundle);

      setLoadingStage('heuristics');

      // Step 5: heuristics (synchronous).
      const heuristicFlags = runHeuristics(idx, bundle, report);

      // Commit all state atomically.
      setBundles([bundle]);
      setIndex(idx);
      setValidationReport(report);
      setFlags(heuristicFlags);
      setStatus('loaded');
      setLoadingStage(null);
    } catch (err: unknown) {
      // Safety net: should not normally trigger since loadBundle returns Result.
      setLoadError({
        kind: 'unknown_failure',
        detail: err instanceof Error ? err.message : 'Unexpected error during load.',
      });
      setStatus('error');
      setLoadingStage(null);
    }
  }, []);

  const clearBundle = useCallback(() => {
    setBundles([]);
    setIndex(null);
    setValidationReport(null);
    setFlags([]);
    setStatus('idle');
    setLoadingStage(null);
    setLoadError(null);
  }, []);

  const value = useMemo<BundleContextValue>(
    () => ({
      bundles,
      index,
      validationReport,
      flags,
      status,
      loadingStage,
      loadError,
      loadBundleFile,
      clearBundle,
    }),
    [
      bundles,
      index,
      validationReport,
      flags,
      status,
      loadingStage,
      loadError,
      loadBundleFile,
      clearBundle,
    ],
  );

  return <BundleContext.Provider value={value}>{children}</BundleContext.Provider>;
}
