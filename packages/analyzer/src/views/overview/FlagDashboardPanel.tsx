/**
 * FlagDashboardPanel — sorted flag list with severity chips and confidence bars.
 *
 * PRD §7.4.
 *
 * Flags arrive pre-sorted (severity desc, confidence desc) — from runHeuristics
 * on /local, from the flags endpoint's ORDER BY on the server path. Each row
 * opens a HeuristicDetailDrawer on click.
 *
 * Route-agnostic: navigation is delegated to the caller, so /local and the
 * submission tab share one implementation.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Progress } from '@/components/ui/progress.js';
import { HeuristicDetailDrawer } from './HeuristicDetailDrawer.js';
import { SeverityChip } from './SeverityChip.js';
import type { FlagView, SupportingRef } from './flag-view.js';

interface FlagDashboardPanelProps {
  flags: FlagView[];
  onJumpToTimeline: (ref: SupportingRef) => void;
  onJumpToReplay: (ref: SupportingRef) => void;
  /** Session id → 1-based ordinal, so the drawer can say "Session 2". */
  sessionOrdinals?: ReadonlyMap<string, number> | undefined;
  /** Fired when any drawer opens; lets a caller lazily load supporting-event data. */
  onDrawerOpen?: (() => void) | undefined;
}

type FlagRowProps = {
  flag: FlagView;
} & Omit<FlagDashboardPanelProps, 'flags'>;

function FlagRow({
  flag,
  onJumpToTimeline,
  onJumpToReplay,
  sessionOrdinals,
  onDrawerOpen,
}: FlagRowProps) {
  const pct = Math.round(flag.confidence * 100);

  return (
    <HeuristicDetailDrawer
      flag={flag}
      onJumpToTimeline={onJumpToTimeline}
      onJumpToReplay={onJumpToReplay}
      sessionOrdinals={sessionOrdinals}
      onOpen={onDrawerOpen}
    >
      <button
        type="button"
        className="w-full rounded-md border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:ring-2 focus:ring-ring focus:outline-none"
        data-testid={`flag-row-${flag.id}`}
      >
        <div className="flex items-center gap-3">
          {/* Severity chip */}
          <div className="shrink-0">
            <SeverityChip severity={flag.severity} />
          </div>

          {/* Title */}
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={flag.title}>
            {flag.title}
          </span>

          {/* Supporting count */}
          <span className="shrink-0 text-xs text-muted-foreground">
            {flag.supporting.length} {flag.supporting.length === 1 ? 'event' : 'events'}
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

export function FlagDashboardPanel({
  flags,
  onJumpToTimeline,
  onJumpToReplay,
  sessionOrdinals,
  onDrawerOpen,
}: FlagDashboardPanelProps) {
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
              <FlagRow
                key={flag.id}
                flag={flag}
                onJumpToTimeline={onJumpToTimeline}
                onJumpToReplay={onJumpToReplay}
                sessionOrdinals={sessionOrdinals}
                onDrawerOpen={onDrawerOpen}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
