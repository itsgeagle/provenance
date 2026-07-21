/**
 * HeuristicDetailDrawer — right-side drawer showing full flag detail.
 *
 * PRD §7.4.
 *
 * Uses a Radix Dialog in the DrawerContent variant (right panel, not centered
 * modal). Esc and overlay-click close are free from Radix.
 *
 * Route-agnostic: it renders a `FlagView` and calls `onJumpToTimeline` /
 * `onJumpToReplay` rather than navigating itself, so the same drawer serves
 * /local (which navigates to /local/timeline and /local/replay/:sessionId) and
 * the submission tab (which flips ?tab= on the current route). This mirrors how
 * TimelineInner is shared between the two.
 *
 * Supporting events are grouped by session. A flag whose evidence spans
 * sessions is the case the server path used to get wrong, so the drawer says so
 * explicitly rather than presenting a flat list that reads as one sitting.
 */

import {
  Dialog,
  DialogTrigger,
  DrawerContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog.js';
import { ScrollArea } from '@/components/ui/scroll-area.js';
import { Progress } from '@/components/ui/progress.js';
import { Button } from '@/components/ui/button.js';
import { SeverityChip } from './SeverityChip.js';
import {
  groupSupportingBySession,
  countSessionsSpanned,
  type FlagView,
  type SupportingRef,
} from './flag-view.js';

// ---------------------------------------------------------------------------
// Supporting event row
// ---------------------------------------------------------------------------

interface SupportingEventRowProps {
  supportingRef: SupportingRef;
  onJumpToTimeline: (ref: SupportingRef) => void;
  onJumpToReplay: (ref: SupportingRef) => void;
}

function SupportingEventRow({
  supportingRef,
  onJumpToTimeline,
  onJumpToReplay,
}: SupportingEventRowProps) {
  const { event } = supportingRef;

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        {event !== null ? (
          <>
            <span className="font-mono text-xs text-foreground">{event.kind}</span>
            {event.file !== undefined && (
              <span
                className="ml-2 truncate font-mono text-xs text-muted-foreground"
                title={event.file}
              >
                {event.file}
              </span>
            )}
            <span className="ml-2 text-xs text-muted-foreground">
              {new Date(event.wall).toLocaleTimeString()}
            </span>
          </>
        ) : (
          // Index not loaded yet (or this seq names no event). Still navigable —
          // the destination resolves the event on arrival.
          <span className="font-mono text-xs text-muted-foreground">
            event #{supportingRef.globalIdx ?? '—'}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onJumpToTimeline(supportingRef)}
          data-testid={`jump-btn-${supportingRef.id}`}
        >
          Raw timeline
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onJumpToReplay(supportingRef)}
          data-testid={`jump-replay-btn-${supportingRef.id}`}
        >
          ▶ Replay
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer internals
// ---------------------------------------------------------------------------

interface DrawerBodyProps {
  flag: FlagView;
  onJumpToTimeline: (ref: SupportingRef) => void;
  onJumpToReplay: (ref: SupportingRef) => void;
  /** Session id → 1-based ordinal, for readable "Session 2" headers. */
  sessionOrdinals?: ReadonlyMap<string, number> | undefined;
}

function DrawerBody({ flag, onJumpToTimeline, onJumpToReplay, sessionOrdinals }: DrawerBodyProps) {
  const pct = Math.round(flag.confidence * 100);
  const groups = groupSupportingBySession(flag.supporting);
  const sessionsSpanned = countSessionsSpanned(flag.supporting);
  // Only label sessions when there is more than one to tell apart — a header on
  // every row of a single-session flag is noise.
  const showSessionHeaders = groups.length > 1;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5 pr-12">
        <DialogTitle className="text-xl font-semibold">{flag.title}</DialogTitle>
        <DialogDescription asChild>
          <div className="mt-2 flex items-center gap-3">
            <SeverityChip severity={flag.severity} data-testid="drawer-severity" />
            <div className="flex flex-1 items-center gap-2">
              <Progress
                value={pct}
                className="h-2 max-w-[120px]"
                aria-label={`Confidence ${pct}%`}
              />
              <span className="text-xs text-muted-foreground">{pct}% confidence</span>
            </div>
          </div>
        </DialogDescription>
      </div>

      {/* Scrollable body */}
      <ScrollArea className="flex-1">
        <div className="space-y-6 px-6 py-5">
          {/* Description */}
          {flag.description !== '' && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Description</h3>
              <p className="break-words text-sm text-muted-foreground">{flag.description}</p>
            </section>
          )}

          {/* Supporting events */}
          {flag.supporting.length > 0 && (
            <section>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  Supporting events ({flag.supporting.length})
                </h3>
                {sessionsSpanned > 1 && (
                  <span
                    className="text-xs font-medium text-amber-700"
                    data-testid="spans-sessions-note"
                  >
                    spans {sessionsSpanned} sessions
                  </span>
                )}
              </div>
              <div className="space-y-3" data-testid="supporting-events-list">
                {groups.map((group) => (
                  <div key={group.sessionId ?? '__unresolved'} className="space-y-1">
                    {showSessionHeaders && (
                      <p
                        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        data-testid={`supporting-session-header-${group.sessionId ?? 'unresolved'}`}
                      >
                        {group.sessionId === null
                          ? 'Session not yet resolved'
                          : sessionOrdinals?.has(group.sessionId)
                            ? `Session ${sessionOrdinals.get(group.sessionId)}`
                            : `Session ${group.sessionId.slice(0, 8)}…`}
                      </p>
                    )}
                    {group.refs.map((ref) => (
                      <SupportingEventRow
                        key={ref.id}
                        supportingRef={ref}
                        onJumpToTimeline={onJumpToTimeline}
                        onJumpToReplay={onJumpToReplay}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Detail JSON */}
          {flag.detail !== undefined && Object.keys(flag.detail).length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Detail</h3>
              <ScrollArea className="max-h-48 rounded-md border bg-muted/50">
                <pre
                  className="p-3 font-mono text-xs break-all whitespace-pre-wrap"
                  data-testid="detail-json"
                >
                  {JSON.stringify(flag.detail, null, 2)}
                </pre>
              </ScrollArea>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface HeuristicDetailDrawerProps {
  flag: FlagView;
  children: React.ReactNode;
  onJumpToTimeline: (ref: SupportingRef) => void;
  onJumpToReplay: (ref: SupportingRef) => void;
  sessionOrdinals?: ReadonlyMap<string, number> | undefined;
  /**
   * Called when the drawer opens. The server path uses this to start loading
   * the event index, which is only needed once a drawer is actually opened.
   */
  onOpen?: (() => void) | undefined;
}

export function HeuristicDetailDrawer({
  flag,
  children,
  onJumpToTimeline,
  onJumpToReplay,
  sessionOrdinals,
  onOpen,
}: HeuristicDetailDrawerProps) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DrawerContent data-testid="heuristic-drawer">
        <DrawerBody
          flag={flag}
          onJumpToTimeline={onJumpToTimeline}
          onJumpToReplay={onJumpToReplay}
          sessionOrdinals={sessionOrdinals}
        />
      </DrawerContent>
    </Dialog>
  );
}
