/**
 * HeuristicDetailDrawer — right-side drawer showing full flag detail.
 *
 * PRD §7.4.
 *
 * Uses a Radix Dialog in the DrawerContent variant (right panel, not centered
 * modal). Esc and overlay-click close are free from Radix.
 *
 * Phase 15: each supporting event row now has a "Jump to replay" button
 * alongside the existing "Jump to raw timeline" button.
 *
 * Resolving globalIdx from seqKey:
 *   seqKey = "${sessionId}:${seq}"
 *   globalIdx = index.bySeq.get(seqKey)?.globalIdx
 *   The replay route is /replay/:sessionId?event=:globalIdx
 */

import { useNavigate } from 'react-router-dom';
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
import { useBundle } from '../../context/BundleContext.js';
import type { Flag } from '../../heuristics/types.js';

// ---------------------------------------------------------------------------
// Supporting event list
// ---------------------------------------------------------------------------

interface SupportingEventRowProps {
  seqKey: string;
  /** globalIdx resolved from index.bySeq, or null if unavailable. */
  globalIdx: number | null;
}

function SupportingEventRow({ seqKey, globalIdx }: SupportingEventRowProps) {
  const navigate = useNavigate();

  // seqKey format: "${sessionId}:${seq}"
  const colonIdx = seqKey.indexOf(':');
  const sessionId = colonIdx !== -1 ? seqKey.slice(0, colonIdx) : seqKey;
  const seqStr = colonIdx !== -1 ? seqKey.slice(colonIdx + 1) : '';
  const seqNum = seqStr !== '' ? parseInt(seqStr, 10) : NaN;

  const label = isNaN(seqNum) ? seqKey : `seq #${seqNum} (session ${sessionId.slice(0, 8)}…)`;

  const handleJumpTimeline = () => {
    void navigate(`/timeline?seq=${seqKey}`);
  };

  const handleJumpReplay = () => {
    if (globalIdx === null) return;
    void navigate(`/replay/${sessionId}?event=${globalIdx}`);
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={seqKey}>
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleJumpTimeline}
          data-testid={`jump-btn-${seqKey}`}
        >
          Raw timeline
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleJumpReplay}
          disabled={globalIdx === null}
          data-testid={`jump-replay-btn-${seqKey}`}
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

function DrawerBody({ flag }: { flag: Flag }) {
  const pct = Math.round(flag.confidence * 100);
  const { index } = useBundle();

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
          <section>
            <h3 className="mb-1 text-sm font-semibold">Description</h3>
            <p className="break-words text-sm text-muted-foreground">{flag.description}</p>
          </section>

          {/* Supporting events */}
          {flag.supportingSeqs.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Supporting events ({flag.supportingSeqs.length})
              </h3>
              <div className="space-y-1" data-testid="supporting-events-list">
                {flag.supportingSeqs.map((seqKey) => {
                  // Resolve globalIdx from index.bySeq once per row render.
                  // index is null before bundle loads; globalIdx is null → replay button disabled.
                  const globalIdx = index?.bySeq.get(seqKey)?.globalIdx ?? null;
                  return <SupportingEventRow key={seqKey} seqKey={seqKey} globalIdx={globalIdx} />;
                })}
              </div>
            </section>
          )}

          {/* Detail JSON */}
          {flag.detail !== undefined && Object.keys(flag.detail).length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Detail</h3>
              <ScrollArea className="max-h-48 rounded-md border bg-muted/50">
                <pre
                  className="p-3 text-xs font-mono whitespace-pre-wrap break-all"
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
  flag: Flag;
  children: React.ReactNode;
}

export function HeuristicDetailDrawer({ flag, children }: HeuristicDetailDrawerProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DrawerContent data-testid="heuristic-drawer">
        <DrawerBody flag={flag} />
      </DrawerContent>
    </Dialog>
  );
}
