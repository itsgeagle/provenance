/**
 * SpeedControl — speed preset dropdown for the replay view.
 *
 * Design choices (A43):
 *   - Uses the existing @radix-ui/react-dropdown-menu primitive (Phase 7).
 *   - Preset speeds: [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256]. The ceiling
 *     was raised from 32× because long submissions were unwatchable at 32×.
 *     Cost is flat: engine.tick() seeks to the LAST event in the virtual-time
 *     window rather than applying events one at a time, so a bigger multiplier
 *     is one seek per frame regardless of how many events it crosses.
 *   - If the current speed matches a preset, that item shows a check indicator.
 *   - If the current speed is NOT a preset (e.g. ?speed=3 from URL), the trigger
 *     shows "3×" as the current value without a matching item in the list.
 *     No rounding — the raw numeric value is displayed.
 *   - Selecting a preset calls onSpeedChange(preset) and DOES NOT restart
 *     playback; the parent layer (ReplayViewInner → play()) decides whether
 *     to apply the speed immediately or on next play.
 */

import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SpeedControlProps {
  /** Current playback speed (from engine state / URL). */
  speed: number;
  /** Called when the user picks a new preset. */
  onSpeedChange: (speed: number) => void;
  /** Whether the control should be disabled (e.g. when there are no events). */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// SpeedControl
// ---------------------------------------------------------------------------

/**
 * Format a speed value for display. e.g. 0.25 → "0.25×", 2 → "2×".
 */
function formatSpeed(speed: number): string {
  // Use toPrecision to avoid floating-point noise like "0.25000000001"
  // but trim trailing zeros for integers.
  const s = parseFloat(speed.toPrecision(8));
  return `${s}×`;
}

export function SpeedControl({ speed, onSpeedChange, disabled = false }: SpeedControlProps) {
  const currentLabel = formatSpeed(speed);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Playback speed: ${currentLabel}`}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium tabular-nums',
          'border bg-background hover:bg-accent hover:text-accent-foreground',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'data-[state=open]:bg-accent',
        )}
        data-testid="speed-control-trigger"
      >
        {currentLabel}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[6rem]">
        {SPEED_PRESETS.map((preset) => {
          const isSelected = preset === speed;
          return (
            <DropdownMenuItem
              key={preset}
              className="flex items-center justify-between gap-2 tabular-nums"
              onSelect={() => onSpeedChange(preset)}
              data-testid={`speed-option-${preset}`}
              aria-selected={isSelected}
            >
              <span>{formatSpeed(preset)}</span>
              {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
