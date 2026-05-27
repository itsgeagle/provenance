/**
 * ExportPanel — submission export tab.
 *
 * V46: the Phase 24 implementation polled an async PDF job endpoint that
 * never shipped, and the markdown sync path equally had no server handler
 * (the route is a Phase 25 carry-over). Rather than leave a button that
 * 404s, this tab now surfaces a v3.1 stub. The shared ExportJobSchema is
 * retained for when the server endpoint lands.
 */

export function ExportPanel() {
  return (
    <div className="container mx-auto py-12 px-4 max-w-lg text-center" data-testid="export-panel">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Export</h2>
      <p className="text-sm text-gray-500">
        Submission export (markdown and PDF) is planned for v3.1. The
        client-side findings export under <span className="font-mono">/local</span> remains
        available for ad-hoc use.
      </p>
    </div>
  );
}
