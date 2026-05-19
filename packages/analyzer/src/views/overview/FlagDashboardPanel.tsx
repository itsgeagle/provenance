/**
 * FlagDashboardPanel — sorted flag list with severity chips and confidence bars.
 *
 * PRD §7.4.
 *
 * Flags arrive pre-sorted from runHeuristics (severity desc, confidence desc).
 * Each row opens a HeuristicDetailDrawer on click.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Progress } from '@/components/ui/progress.js';
import { HeuristicDetailDrawer } from './HeuristicDetailDrawer.js';
import { SeverityChip } from './SeverityChip.js';
import type { Flag } from '../../heuristics/types.js';

interface FlagDashboardPanelProps {
  flags: Flag[];
}

function FlagRow({ flag }: { flag: Flag }) {
  const pct = Math.round(flag.confidence * 100);

  return (
    <HeuristicDetailDrawer flag={flag}>
      <button
        type="button"
        className="w-full rounded-md border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid={`flag-row-${flag.id}`}
      >
        <div className="flex items-center gap-3">
          {/* Severity chip */}
          <div className="shrink-0">
            <SeverityChip severity={flag.severity} />
          </div>

          {/* Title */}
          <span className="flex-1 text-sm font-medium">{flag.title}</span>

          {/* Supporting count */}
          <span className="shrink-0 text-xs text-muted-foreground">
            {flag.supportingSeqs.length} {flag.supportingSeqs.length === 1 ? 'event' : 'events'}
          </span>
        </div>

        {/* Confidence bar */}
        <div className="mt-2 flex items-center gap-2">
          <Progress value={pct} className="h-1.5 flex-1" aria-label={`Confidence ${pct}%`} />
          <span className="w-10 shrink-0 text-right text-xs text-muted-foreground">{pct}%</span>
        </div>
      </button>
    </HeuristicDetailDrawer>
  );
}

export function FlagDashboardPanel({ flags }: FlagDashboardPanelProps) {
  return (
    <Card data-testid="flag-dashboard-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Heuristic Flags</CardTitle>
          <span className="text-sm text-muted-foreground">
            {flags.length} {flags.length === 1 ? 'flag' : 'flags'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {flags.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-flags-message">
            No flags raised.
          </p>
        ) : (
          <div className="space-y-2" data-testid="flag-list">
            {flags.map((flag) => (
              <FlagRow key={flag.id} flag={flag} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
