/**
 * JumpControls — jump buttons for the replay view.
 *
 * PRD ref: §7.2 (jump-to: next paste/external/flag/file-switch).
 *
 * Buttons:
 *   - Next paste (paste event)
 *   - Next external change (fs.external_change event)
 *   - Next flag (event whose globalIdx appears in any flag's supportingSeqs)
 *   - Next file switch (event where file differs from the prior file-bearing event)
 *   - Next session boundary (multi-session bundles only)
 *
 * Each button:
 *   - Disables when no next match exists.
 *   - Shows a tooltip with the count of remaining matches.
 *   - Calls engine.seek(nextGlobalIdx) when clicked, which pauses the engine
 *     (seek does not change play status; useReplayEngine exposes seek which
 *     leaves status as-is; but we explicitly pause before seeking via a
 *     handleJump wrapper in the parent ReplayViewInner).
 *
 * Design notes (A44):
 *   - `flaggedSet` is memoized in the parent (ReplayViewInner) to avoid
 *     rebuilding the Set on every render.
 *   - The four predicates are pure functions from jump-predicates.ts.
 *   - JumpControls itself is a display component: it receives pre-computed
 *     counts and next-target indices. The parent computes them via useMemo.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JumpControlsProps {
  /** The globalIdx of the next paste event, or null if none. */
  nextPaste: number | null;
  /** The globalIdx of the next fs.external_change event, or null if none. */
  nextExternalChange: number | null;
  /** The globalIdx of the next flagged event, or null if none. */
  nextFlag: number | null;
  /** The globalIdx of the next file-switch event, or null if none. */
  nextFileSwitch: number | null;
  /**
   * The globalIdx of the next session boundary, or null if none. Undefined for
   * single-session bundles, which hide the control entirely.
   */
  nextSeam?: number | null | undefined;

  /** Count of remaining pastes (for tooltip). */
  remainingPastes: number;
  /** Count of remaining external changes (for tooltip). */
  remainingExternalChanges: number;
  /** Count of remaining flagged events (for tooltip). */
  remainingFlags: number;
  /** Count of remaining file switches (for tooltip). */
  remainingFileSwitches: number;
  /** Count of remaining session boundaries (for tooltip). */
  remainingSeams?: number | undefined;
  /** Whether the bundle has more than one session. Hides the seam button when false. */
  hasSeams?: boolean | undefined;

  /** Seek the engine to this globalIdx (and pause). */
  onSeek: (globalIdx: number) => void;
}

// ---------------------------------------------------------------------------
// Single jump button
// ---------------------------------------------------------------------------

interface JumpButtonProps {
  label: string;
  icon: string;
  nextIdx: number | null;
  remaining: number;
  noun: string;
  onSeek: (globalIdx: number) => void;
  testId: string;
}

function JumpButton({ label, icon, nextIdx, remaining, noun, onSeek, testId }: JumpButtonProps) {
  const disabled = nextIdx === null;
  const tooltipText = disabled
    ? `No more ${noun}s`
    : `${remaining} ${noun}${remaining === 1 ? '' : 's'} remaining`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={disabled}
          onClick={() => {
            if (nextIdx !== null) onSeek(nextIdx);
          }}
          aria-label={label}
          data-testid={testId}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// JumpControls
// ---------------------------------------------------------------------------

export function JumpControls({
  nextPaste,
  nextExternalChange,
  nextFlag,
  nextFileSwitch,
  remainingPastes,
  remainingExternalChanges,
  remainingFlags,
  remainingFileSwitches,
  nextSeam = null,
  remainingSeams = 0,
  hasSeams = false,
  onSeek,
}: JumpControlsProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex items-center gap-1.5 px-4 py-1.5 border-t bg-muted/30"
        data-testid="jump-controls"
      >
        <span className="mr-1 text-xs text-muted-foreground font-medium shrink-0">Jump:</span>

        <JumpButton
          label="Paste"
          icon="⎘"
          nextIdx={nextPaste}
          remaining={remainingPastes}
          noun="paste"
          onSeek={onSeek}
          testId="jump-paste"
        />

        <JumpButton
          label="External"
          icon="⚡"
          nextIdx={nextExternalChange}
          remaining={remainingExternalChanges}
          noun="external change"
          onSeek={onSeek}
          testId="jump-external"
        />

        <JumpButton
          label="Flag"
          icon="⚑"
          nextIdx={nextFlag}
          remaining={remainingFlags}
          noun="flagged event"
          onSeek={onSeek}
          testId="jump-flag"
        />

        <JumpButton
          label="File switch"
          icon="⇄"
          nextIdx={nextFileSwitch}
          remaining={remainingFileSwitches}
          noun="file switch"
          onSeek={onSeek}
          testId="jump-file-switch"
        />

        {/* Only meaningful for multi-session bundles; hidden otherwise so
            single-session replays look exactly as they did before. */}
        {hasSeams && (
          <JumpButton
            label="Session"
            icon="⏭"
            nextIdx={nextSeam}
            remaining={remainingSeams}
            noun="session boundary"
            onSeek={onSeek}
            testId="jump-seam"
          />
        )}
      </div>
    </TooltipProvider>
  );
}
