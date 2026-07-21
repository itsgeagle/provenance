/**
 * SkipIdleToggle — compresses long think-pauses during replay.
 *
 * A recorded session is mostly waiting: a student stares at the screen for
 * fifteen minutes, then types. Raising the speed multiplier scales that dead
 * air down but never removes it, so this toggle caps how long any single
 * within-session pause plays for (MAX_IDLE_GAP_MS in engine-core).
 *
 * Default ON, decided deliberately. The compression is pacing only — it never
 * applies an event early and never touches `bundleT` — so the scrub slider,
 * seam ticks, event counts and every duration shown in the UI still describe
 * real recorded time. A reviewer who needs to feel the true length of a pause
 * turns this off; nothing is hidden from them either way.
 *
 * Styled to match SpeedControl's trigger so the two read as one control group.
 */

import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SkipIdleToggleProps {
  /** Whether idle-gap compression is currently on. */
  skipIdle: boolean;
  /** Called with the new value when the user toggles. */
  onSkipIdleChange: (skipIdle: boolean) => void;
  /** Disabled when there is nothing to play (e.g. no events). */
  disabled?: boolean;
}

export function SkipIdleToggle({
  skipIdle,
  onSkipIdleChange,
  disabled = false,
}: SkipIdleToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={skipIdle}
      aria-label="Skip idle gaps"
      title={
        skipIdle
          ? 'Skipping idle gaps — long pauses play as a brief beat. Timeline still shows real time.'
          : 'Playing idle gaps at full length.'
      }
      disabled={disabled}
      onClick={() => onSkipIdleChange(!skipIdle)}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
        'border focus:outline-none focus:ring-1 focus:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-40',
        skipIdle
          ? 'bg-accent text-accent-foreground'
          : 'bg-background hover:bg-accent hover:text-accent-foreground',
      )}
      data-testid="skip-idle-toggle"
    >
      <Hourglass className={cn('h-3 w-3', !skipIdle && 'opacity-60')} />
      Skip idle
    </button>
  );
}
