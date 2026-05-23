/**
 * Actions — top-of-overview action bar.
 *
 * Buttons:
 *   - "View Replay" — navigates to /replay/<first-session-id>. Disabled when
 *      no bundle is loaded.
 *   - "Open Raw Timeline" — navigates to /timeline.
 *   - "Export Findings (Markdown)" — Phase 8, wired via <ExportMarkdownButton />.
 *   - "Export Findings (PDF)" — Phase 19, wired via <ExportPdfButton />.
 *
 * The replay button defaults to the first (chronologically earliest) session
 * in the bundle. Multi-session bundles can switch sessions from the replay
 * route itself; the overview action is the entry point.
 */

import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button.js';
import { useBundle } from '@/context/BundleContext.js';
import { ExportMarkdownButton } from './ExportMarkdownButton.js';
import { ExportPdfButton } from './ExportPdfButton.js';

export function Actions() {
  const navigate = useNavigate();
  const { bundles, status } = useBundle();

  const firstSessionId = bundles[0]?.sessions[0]?.sessionId;
  const replayEnabled = status === 'loaded' && firstSessionId !== undefined;

  const handleTimeline = () => {
    void navigate('/local/timeline');
  };

  const handleReplay = () => {
    if (firstSessionId === undefined) return;
    void navigate(`/local/replay/${firstSessionId}`);
  };

  return (
    <div className="flex flex-wrap gap-3" data-testid="overview-actions">
      <Button
        variant="default"
        onClick={handleReplay}
        disabled={!replayEnabled}
        data-testid="btn-view-replay"
      >
        View Replay
      </Button>

      <Button variant="outline" onClick={handleTimeline} data-testid="btn-open-timeline">
        Open Raw Timeline
      </Button>

      <ExportMarkdownButton />
      <ExportPdfButton />
    </div>
  );
}
