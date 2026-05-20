/**
 * BundleContext — provides loaded bundle state to all routes.
 *
 * v2 Phase 11 changes:
 * - Per-bundle maps: `indicesByBundle`, `validationReportByBundle`, `flagsByBundle`
 *   keyed by Bundle.id. These are the sources of truth.
 * - `selectedBundleId`: the currently "active" bundle for single-bundle consumers.
 *   Defaults to the first bundle's id when loaded.
 * - Derived scalar accessors `index`, `validationReport`, `flags` read from the
 *   maps using `selectedBundleId`. All v1 consumers (OverviewView, TimelineView,
 *   ExportMarkdownButton, etc.) continue to work with zero changes.
 * - `loadBundleFile` appends to the existing bundle list (used by the header
 *   "Load more bundles" button); `loadBundleFiles` is the multi-file fan-out.
 * - `clearBundle` resets to idle (used by "Load different bundle" which clears all).
 *
 * Design notes (A26):
 * - `bundles` is plural-shaped; v1 always had length 0 or 1.
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
import { loadBundle, parseBundles } from '../loader/parse-bundle.js';
import { buildIndex } from '../index/build-index.js';
import { runValidation } from '../validation/run-validation.js';
import { runHeuristics } from '../heuristics/run-heuristics.js';
import type { Bundle, LoaderError, SessionParseError } from '../loader/types.js';
import type { BlobLoadError } from '../loader/parse-bundle.js';
import type { EventIndex } from '../index/event-index.js';
import type { ValidationReport } from '../validation/check-types.js';
import type { Flag } from '../heuristics/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadingStage = 'unzip' | 'parse' | 'index' | 'validate' | 'heuristics' | null;

export type BundleContextValue = {
  /** All loaded bundles. Empty when idle/error. */
  bundles: Bundle[];

  /** The id of the currently selected bundle. Null when nothing is loaded. */
  selectedBundleId: string | null;
  /** Switch the active bundle for all single-bundle consumers. */
  selectBundle(id: string): void;

  // Per-bundle maps — sources of truth.
  indicesByBundle: Map<string, EventIndex>;
  validationReportByBundle: Map<string, ValidationReport>;
  flagsByBundle: Map<string, Flag[]>;

  // Derived single-bundle scalars — read from maps using selectedBundleId.
  // These keep v1 consumers working unchanged.
  index: EventIndex | null;
  validationReport: ValidationReport | null;
  flags: Flag[];

  status: 'idle' | 'loading' | 'loaded' | 'error';
  loadingStage: LoadingStage;
  /** The loader error, set when status === 'error'. */
  loadError: LoaderError | SessionParseError | null;
  /**
   * Per-blob errors from the most recent multi-file load.
   * Non-empty when some files succeeded and some failed (partial load).
   */
  partialLoadErrors: BlobLoadError[];

  /** Load a single bundle file (append, not replace). */
  loadBundleFile(file: File): Promise<void>;
  /** Load multiple bundle files at once (fan-out, append). */
  loadBundleFiles(files: File[]): Promise<void>;
  /** Reset state back to idle. */
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
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [indicesByBundle, setIndicesByBundle] = useState<Map<string, EventIndex>>(new Map());
  const [validationReportByBundle, setValidationReportByBundle] = useState<
    Map<string, ValidationReport>
  >(new Map());
  const [flagsByBundle, setFlagsByBundle] = useState<Map<string, Flag[]>>(new Map());

  const [status, setStatus] = useState<BundleContextValue['status']>('idle');
  const [loadingStage, setLoadingStage] = useState<LoadingStage>(null);
  const [loadError, setLoadError] = useState<LoaderError | SessionParseError | null>(null);
  const [partialLoadErrors, setPartialLoadErrors] = useState<BlobLoadError[]>([]);

  // ---------------------------------------------------------------------------
  // Internal: process one parsed bundle and add it to state.
  // Returns the bundle id for selectedBundleId defaulting.
  // ---------------------------------------------------------------------------

  /**
   * Given a fully-parsed Bundle, build its index + validation + heuristics,
   * and merge into the per-bundle maps.
   *
   * Returns the bundle's id so callers can update selectedBundleId if needed.
   */
  const processBundleResult = useCallback(
    async (
      bundle: Bundle,
      prevBundles: Bundle[],
      prevIndices: Map<string, EventIndex>,
      prevReports: Map<string, ValidationReport>,
      prevFlags: Map<string, Flag[]>,
      setStage: (s: LoadingStage) => void,
    ): Promise<{
      newBundles: Bundle[];
      newIndices: Map<string, EventIndex>;
      newReports: Map<string, ValidationReport>;
      newFlags: Map<string, Flag[]>;
    }> => {
      setStage('index');
      const idx = buildIndex(bundle);

      setStage('validate');
      const report = await runValidation(bundle);

      setStage('heuristics');
      const heuristicFlags = runHeuristics(idx, bundle, report);

      const newIndices = new Map(prevIndices);
      newIndices.set(bundle.id, idx);

      const newReports = new Map(prevReports);
      newReports.set(bundle.id, report);

      const newFlags = new Map(prevFlags);
      newFlags.set(bundle.id, heuristicFlags);

      const newBundles = [...prevBundles, bundle];

      return { newBundles, newIndices, newReports, newFlags };
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // loadBundleFile — single file, append
  // ---------------------------------------------------------------------------

  const loadBundleFile = useCallback(
    async (file: File) => {
      setStatus('loading');
      setLoadError(null);
      setPartialLoadErrors([]);
      setLoadingStage('unzip');

      try {
        const bundleResult = await loadBundle(file, file.name);
        if (!bundleResult.ok) {
          setLoadError(bundleResult.error);
          setStatus('error');
          setLoadingStage(null);
          return;
        }
        const bundle = bundleResult.value;

        // Capture current state for the merge (useState setter gives prev value).
        // We pass current state snapshots; since this is a sequential async fn,
        // there's no concurrent write risk.
        const { newBundles, newIndices, newReports, newFlags } = await processBundleResult(
          bundle,
          bundles,
          indicesByBundle,
          validationReportByBundle,
          flagsByBundle,
          setLoadingStage,
        );

        setBundles(newBundles);
        setIndicesByBundle(newIndices);
        setValidationReportByBundle(newReports);
        setFlagsByBundle(newFlags);
        // Default selectedBundleId to first bundle if not yet set.
        setSelectedBundleId((prev) => prev ?? bundle.id);
        setStatus('loaded');
        setLoadingStage(null);
      } catch (err: unknown) {
        setLoadError({
          kind: 'unknown_failure',
          detail: err instanceof Error ? err.message : 'Unexpected error during load.',
        });
        setStatus('error');
        setLoadingStage(null);
      }
    },
    [bundles, indicesByBundle, validationReportByBundle, flagsByBundle, processBundleResult],
  );

  // ---------------------------------------------------------------------------
  // loadBundleFiles — multi-file fan-out, append
  // ---------------------------------------------------------------------------

  const loadBundleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setStatus('loading');
      setLoadError(null);
      setPartialLoadErrors([]);
      setLoadingStage('unzip');

      try {
        const blobs = files.map((f) => f as Blob);
        const filenames = files.map((f) => f.name);
        const { bundles: parsed, errors } = await parseBundles(blobs, filenames);

        // If ALL blobs failed, treat as a hard error.
        if (parsed.length === 0 && errors.length > 0) {
          setLoadError(errors[0]!.error);
          setStatus('error');
          setLoadingStage(null);
          return;
        }

        // Partial failures are surfaced as partialLoadErrors (non-blocking).
        setPartialLoadErrors(errors);

        // Process each successfully parsed bundle sequentially so stage labels
        // advance predictably. Order-independent but sequential avoids multiple
        // concurrent validation calls (WebCrypto) that could interleave stage labels.
        let currentBundles = bundles;
        let currentIndices = indicesByBundle;
        let currentReports = validationReportByBundle;
        let currentFlags = flagsByBundle;
        let firstId: string | null = null;

        for (const bundle of parsed) {
          setLoadingStage('index');
          const { newBundles, newIndices, newReports, newFlags } = await processBundleResult(
            bundle,
            currentBundles,
            currentIndices,
            currentReports,
            currentFlags,
            setLoadingStage,
          );
          currentBundles = newBundles;
          currentIndices = newIndices;
          currentReports = newReports;
          currentFlags = newFlags;
          if (firstId === null) firstId = bundle.id;
        }

        setBundles(currentBundles);
        setIndicesByBundle(currentIndices);
        setValidationReportByBundle(currentReports);
        setFlagsByBundle(currentFlags);
        setSelectedBundleId((prev) => prev ?? firstId);
        setStatus('loaded');
        setLoadingStage(null);
      } catch (err: unknown) {
        setLoadError({
          kind: 'unknown_failure',
          detail: err instanceof Error ? err.message : 'Unexpected error during load.',
        });
        setStatus('error');
        setLoadingStage(null);
      }
    },
    [bundles, indicesByBundle, validationReportByBundle, flagsByBundle, processBundleResult],
  );

  // ---------------------------------------------------------------------------
  // clearBundle — reset all state
  // ---------------------------------------------------------------------------

  const clearBundle = useCallback(() => {
    setBundles([]);
    setSelectedBundleId(null);
    setIndicesByBundle(new Map());
    setValidationReportByBundle(new Map());
    setFlagsByBundle(new Map());
    setStatus('idle');
    setLoadingStage(null);
    setLoadError(null);
    setPartialLoadErrors([]);
  }, []);

  // ---------------------------------------------------------------------------
  // selectBundle — switch active bundle
  // ---------------------------------------------------------------------------

  const selectBundle = useCallback((id: string) => {
    setSelectedBundleId(id);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived scalars — read from maps using selectedBundleId
  // These keep all v1 consumers working unchanged.
  // ---------------------------------------------------------------------------

  const index = selectedBundleId !== null ? (indicesByBundle.get(selectedBundleId) ?? null) : null;
  const validationReport =
    selectedBundleId !== null ? (validationReportByBundle.get(selectedBundleId) ?? null) : null;
  const flags = selectedBundleId !== null ? (flagsByBundle.get(selectedBundleId) ?? []) : [];

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value = useMemo<BundleContextValue>(
    () => ({
      bundles,
      selectedBundleId,
      selectBundle,
      indicesByBundle,
      validationReportByBundle,
      flagsByBundle,
      index,
      validationReport,
      flags,
      status,
      loadingStage,
      loadError,
      partialLoadErrors,
      loadBundleFile,
      loadBundleFiles,
      clearBundle,
    }),
    [
      bundles,
      selectedBundleId,
      selectBundle,
      indicesByBundle,
      validationReportByBundle,
      flagsByBundle,
      index,
      validationReport,
      flags,
      status,
      loadingStage,
      loadError,
      partialLoadErrors,
      loadBundleFile,
      loadBundleFiles,
      clearBundle,
    ],
  );

  return <BundleContext.Provider value={value}>{children}</BundleContext.Provider>;
}
