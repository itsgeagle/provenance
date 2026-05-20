/**
 * ExportPdfButton — overview Actions wiring for the Phase 19 PDF export.
 *
 * Reads bundle + index + validationReport + flags from BundleContext, calls
 * generatePdf (which orchestrates screenshots + layout), and triggers a
 * browser download via downloadAs.
 *
 * Shows a progress indicator while screenshots are being captured (can take
 * a few seconds for bundles with many medium/high flags).
 *
 * Disabled until the bundle is fully loaded (same guard as ExportMarkdownButton).
 *
 * PRD §7.5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.js';
import { useBundle } from '@/context/BundleContext.js';
import { generatePdf } from '@/export/findings-pdf.js';
import { downloadAs } from '@/export/download.js';

export function ExportPdfButton() {
  const { bundles, index, validationReport, flags, status } = useBundle();

  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const cancelledRef = useRef(false);

  // Guard against state updates on unmounted component.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const handleExport = useCallback(async () => {
    const bundle = bundles[0];
    if (
      status !== 'loaded' ||
      bundle === undefined ||
      validationReport === null ||
      index === null
    ) {
      return;
    }

    setIsExporting(true);
    setProgress(null);

    try {
      const generatedAt = new Date();
      const { doc, filename } = await generatePdf({
        bundle,
        index,
        report: validationReport,
        flags,
        generatedAt,
        onProgress: (completed, total) => {
          if (!cancelledRef.current) {
            setProgress({ completed, total });
          }
        },
      });

      // Convert jsPDF doc to Blob and trigger download.
      const pdfBlob = doc.output('blob');
      downloadAs(filename, pdfBlob);
    } finally {
      if (!cancelledRef.current) {
        setIsExporting(false);
        setProgress(null);
      }
    }
  }, [bundles, index, validationReport, flags, status]);

  const disabled =
    status !== 'loaded' || bundles.length === 0 || validationReport === null || isExporting;

  // Build button label based on export state.
  let label: string;
  if (!isExporting) {
    label = 'Export Findings (PDF)';
  } else if (progress === null) {
    label = 'Preparing PDF…';
  } else {
    label = `Screenshot ${progress.completed}/${progress.total}…`;
  }

  return (
    <Button
      variant="outline"
      onClick={() => void handleExport()}
      disabled={disabled}
      data-testid="btn-export-pdf"
    >
      {label}
    </Button>
  );
}
