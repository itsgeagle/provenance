/**
 * Actions — top-of-overview action bar.
 *
 * Two buttons:
 *   - "Open Raw Timeline" — navigates to /timeline.
 *   - "Export Findings (Markdown)" — Phase 8, wired via <ExportMarkdownButton />.
 *
 * Replay button is Phase 13 — not present here.
 */

import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button.js';
import { ExportMarkdownButton } from './ExportMarkdownButton.js';

export function Actions() {
  const navigate = useNavigate();

  const handleTimeline = () => {
    void navigate('/timeline');
  };

  return (
    <div className="flex flex-wrap gap-3" data-testid="overview-actions">
      <Button variant="outline" onClick={handleTimeline} data-testid="btn-open-timeline">
        Open Raw Timeline
      </Button>

      <ExportMarkdownButton />
    </div>
  );
}
