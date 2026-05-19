/**
 * HeuristicDetailDrawer — right-side drawer showing full flag detail.
 *
 * PRD §7.4.
 *
 * Uses a Radix Dialog in the DrawerContent variant (right panel, not centered
 * modal). Esc and overlay-click close are free from Radix.
 *
 * Phase 15 will add "Jump to replay" buttons alongside the "Jump to raw
 * timeline" buttons.
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
import type { Flag } from '../../heuristics/types.js';

// ---------------------------------------------------------------------------
// Severity color map
// ---------------------------------------------------------------------------

const severityClasses = {
  info: 'bg-gray-100 text-gray-700 border-gray-200',
  low: 'bg-blue-100 text-blue-700 border-blue-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  high: 'bg-red-100 text-red-700 border-red-200',
} as const;

// ---------------------------------------------------------------------------
// Supporting event list
// ---------------------------------------------------------------------------

function SupportingEventRow({ seqKey }: { seqKey: string }) {
  const navigate = useNavigate();
  // seqKey format: "${sessionId}:${seq}"
  const colonIdx = seqKey.indexOf(':');
  const sessionId = colonIdx !== -1 ? seqKey.slice(0, colonIdx) : seqKey;
  const seqStr = colonIdx !== -1 ? seqKey.slice(colonIdx + 1) : '';
  const seqNum = seqStr !== '' ? parseInt(seqStr, 10) : NaN;

  const label = isNaN(seqNum) ? seqKey : `seq #${seqNum} (session ${sessionId.slice(0, 8)}…)`;

  const handleJump = () => {
    void navigate(`/timeline?seq=${seqKey}`);
  };

  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <Button variant="ghost" size="sm" onClick={handleJump} data-testid={`jump-btn-${seqKey}`}>
        Jump to raw timeline
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer internals
// ---------------------------------------------------------------------------

function DrawerBody({ flag }: { flag: Flag }) {
  const pct = Math.round(flag.confidence * 100);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5 pr-12">
        <DialogTitle className="text-xl font-semibold">{flag.title}</DialogTitle>
        <DialogDescription asChild>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${severityClasses[flag.severity]}`}
              data-testid="drawer-severity"
            >
              {flag.severity.toUpperCase()}
            </span>
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
            <p className="text-sm text-muted-foreground">{flag.description}</p>
          </section>

          {/* Supporting events */}
          {flag.supportingSeqs.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Supporting events ({flag.supportingSeqs.length})
              </h3>
              <div className="space-y-1" data-testid="supporting-events-list">
                {flag.supportingSeqs.map((seqKey) => (
                  <SupportingEventRow key={seqKey} seqKey={seqKey} />
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
