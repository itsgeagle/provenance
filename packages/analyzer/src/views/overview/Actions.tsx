/**
 * Actions — top-of-overview action bar.
 *
 * Phase 6 ships two buttons:
 *   - "Open Raw Timeline" — navigates to /timeline.
 *   - "Export Findings (Markdown)" — disabled with a tooltip; Phase 8 wires
 *     the real export action.
 *
 * Replay button is Phase 13 — not present here.
 */

import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button.js';

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

      <Button
        variant="outline"
        disabled
        title="Export will be available in Phase 8"
        data-testid="btn-export-findings"
      >
        Export Findings (Markdown)
      </Button>
    </div>
  );
}
