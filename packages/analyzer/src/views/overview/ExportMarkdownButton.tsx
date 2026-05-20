/**
 * ExportMarkdownButton — overview Actions wiring for the Phase 8 export.
 *
 * Reads bundle + validationReport + flags from BundleContext, renders the
 * Markdown via the pure `renderFindings`, and triggers a browser download.
 *
 * Button is disabled until the bundle is fully loaded — Actions.tsx already
 * lives inside <RequireBundle>, but this component is paranoid and re-checks
 * because a v2 refactor that lifts Actions higher in the tree shouldn't
 * silently produce broken exports.
 */

import { useCallback } from 'react';
import { Button } from '@/components/ui/button.js';
import { useBundle } from '@/context/BundleContext.js';
import { renderFindings, filenameFor } from '@/export/findings-markdown.js';
import { downloadAs } from '@/export/download.js';

export function ExportMarkdownButton() {
  const { bundles, validationReport, flags, crossFlags, status } = useBundle();

  const handleExport = useCallback(() => {
    const bundle = bundles[0];
    if (status !== 'loaded' || bundle === undefined || validationReport === null) {
      // Should not happen — button is disabled in this case — but be safe.
      return;
    }
    // Build a bundleId → sourceFilename map for human-readable cross-flag labels.
    const bundleNamesById: Record<string, string> = {};
    for (const b of bundles) {
      bundleNamesById[b.id] = b.sourceFilename;
    }
    const generatedAt = new Date();
    const markdown = renderFindings(bundle, validationReport, flags, {
      generatedAt,
      crossFlags,
      bundleNamesById,
    });
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    downloadAs(filenameFor(bundle, generatedAt), blob);
  }, [bundles, validationReport, flags, crossFlags, status]);

  const disabled = status !== 'loaded' || bundles.length === 0 || validationReport === null;

  return (
    <Button
      variant="outline"
      onClick={handleExport}
      disabled={disabled}
      data-testid="btn-export-findings"
    >
      Export Findings (Markdown)
    </Button>
  );
}
