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
import type { Flag } from '../../heuristics/types.js';

// ---------------------------------------------------------------------------
// Severity color map (info=gray, low=blue, medium=amber, high=red per plan §A)
// ---------------------------------------------------------------------------

const severityClasses = {
  info: 'bg-gray-100 text-gray-700 border-gray-200',
  low: 'bg-blue-100 text-blue-700 border-blue-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  high: 'bg-red-100 text-red-700 border-red-200',
} as const;

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
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${severityClasses[flag.severity]}`}
            data-testid={`severity-chip-${flag.id}`}
          >
            {flag.severity.toUpperCase()}
          </span>

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
