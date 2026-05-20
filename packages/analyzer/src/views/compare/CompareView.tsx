/**
 * CompareView — cross-submission analysis landing page.
 *
 * Phase 11 ships only the shell:
 *   - A route guard handled by App.tsx ensures bundles.length >= 2 before
 *     rendering this component (callers get a redirect to /load otherwise).
 *   - A checkbox list lets the user select which bundles to compare.
 *   - A stub table area reserves space for the Phase 18 heuristic output.
 *
 * Phase 18 will fill in the cross-submission heuristics table.
 * This component only needs to select bundles and show the placeholder.
 *
 * PRD refs: §7.4 cross-submission heuristics, §8 v2.
 */

import { useState } from 'react';
import { useBundle } from '../../context/BundleContext.js';
import type { Bundle } from '../../loader/types.js';

// ---------------------------------------------------------------------------
// CompareView
// ---------------------------------------------------------------------------

export function CompareView() {
  const { bundles, selectBundle, selectedBundleId } = useBundle();

  // Locally track which bundles are selected for comparison (multi-select).
  // Default: all loaded bundles selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(bundles.map((b) => b.id)),
  );

  const toggleBundle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedBundles: Bundle[] = bundles.filter((b) => selectedIds.has(b.id));

  return (
    <div className="container mx-auto py-8 space-y-8" data-testid="compare-view">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cross-Submission Comparison</h1>
        <p className="text-muted-foreground mt-1">
          Select bundles to compare. Cross-submission heuristics will appear here in Phase 18.
        </p>
      </div>

      {/* Bundle selector */}
      <section aria-labelledby="bundle-selector-heading">
        <h2 id="bundle-selector-heading" className="text-base font-semibold mb-3">
          Select bundles to compare
        </h2>
        <ul className="space-y-2" role="list" data-testid="compare-bundle-list">
          {bundles.map((b) => {
            const isChecked = selectedIds.has(b.id);
            const isActive = b.id === selectedBundleId;
            return (
              <li key={b.id} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`compare-bundle-${b.id}`}
                  checked={isChecked}
                  onChange={() => toggleBundle(b.id)}
                  data-testid={`compare-checkbox-${b.id}`}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  aria-label={`Include ${b.sourceFilename} in comparison`}
                />
                <label htmlFor={`compare-bundle-${b.id}`} className="flex flex-col cursor-pointer">
                  <span className="text-sm font-medium">
                    {b.sourceFilename}
                    {isActive && (
                      <span className="ml-2 text-xs text-muted-foreground">(active)</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {b.manifest.assignment_id} · {b.sessions.length}{' '}
                    {b.sessions.length === 1 ? 'session' : 'sessions'} · loaded{' '}
                    {new Date(b.loadedAt).toLocaleTimeString()}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => selectBundle(b.id)}
                  className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline focus:outline-none focus:underline"
                  data-testid={`compare-activate-${b.id}`}
                >
                  View
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Comparison summary */}
      {selectedBundles.length >= 2 && (
        <section aria-labelledby="compare-summary-heading">
          <h2 id="compare-summary-heading" className="text-base font-semibold mb-3">
            Comparing {selectedBundles.length} bundles
          </h2>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            {selectedBundles.map((b) => (
              <li key={b.id}>{b.sourceFilename}</li>
            ))}
          </ul>
        </section>
      )}

      {selectedBundles.length < 2 && (
        <p className="text-sm text-amber-600" data-testid="compare-need-more">
          Select at least 2 bundles above to enable comparison.
        </p>
      )}

      {/* Phase 18 stub */}
      <section
        aria-labelledby="heuristics-stub-heading"
        className="rounded-lg border border-dashed border-muted-foreground/30 p-8 text-center"
        data-testid="compare-heuristics-stub"
      >
        <h2 id="heuristics-stub-heading" className="text-base font-semibold text-muted-foreground">
          Cross-submission heuristics will appear here in Phase 18
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          Shared-paste detection, editing-pattern similarity, and other cross-bundle signals from
          PRD §7.4 will populate this table.
        </p>
      </section>
    </div>
  );
}
