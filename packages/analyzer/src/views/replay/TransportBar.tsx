/**
 * TransportBar — play / pause / step / scrub controls for the replay view.
 *
 * Layout:
 *   [Step -1] [Play/Pause] [Step +1]  [scrub slider]  [event label]
 *
 * Scrub throttle:
 *   The slider's onValueChange fires on every pixel of drag. To avoid
 *   triggering a full reconstruct per pixel, we throttle via
 *   requestAnimationFrame: only the most recent value in a given animation
 *   frame is applied. This is sufficient for Phase 13's performance budget.
 *
 * Keyboard:
 *   Space → play/pause (on the play/pause button; handled by native button focus).
 *   Arrow keys → handled by Radix Slider natively.
 */

import { useCallback, useRef } from 'react';
import { Slider } from '@/components/ui/slider.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.js';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import type { ReplayState } from './engine-core.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TransportBarProps = {
  state: ReplayState;
  /** Total number of events in the session (slider max). */
  eventCount: number;
  onPlay(): void;
  onPause(): void;
  onStep(n: number): void;
  onSeek(globalIdx: number): void;
};

// ---------------------------------------------------------------------------
// TransportBar
// ---------------------------------------------------------------------------

export function TransportBar({
  state,
  eventCount,
  onPlay,
  onPause,
  onStep,
  onSeek,
}: TransportBarProps) {
  // Slider value: 0-based position, where -1 (before any event) maps to 0
  // and events[N] maps to N+1. We display in 1-based for readability but
  // convert back to globalIdx for the engine.
  const sliderMax = Math.max(0, eventCount - 1);
  const sliderValue = Math.max(0, state.currentGlobalIdx);

  // requestAnimationFrame throttle for scrub.
  const rafRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);

  const handleSliderChange = useCallback(
    (values: number[]) => {
      const newIdx = values[0] ?? 0;
      pendingSeekRef.current = newIdx;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          if (pendingSeekRef.current !== null) {
            onSeek(pendingSeekRef.current);
            pendingSeekRef.current = null;
          }
        });
      }
    },
    [onSeek],
  );

  const isPlaying = state.status === 'playing';
  const atStart = state.currentGlobalIdx <= 0;
  const atEnd = state.currentGlobalIdx >= sliderMax;

  // Display: "event N of M" or "— of M" before first event.
  const eventLabel =
    eventCount === 0
      ? 'No events'
      : state.currentGlobalIdx < 0
        ? `— of ${eventCount}`
        : `${state.currentGlobalIdx + 1} of ${eventCount}`;

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex items-center gap-3 px-4 py-2 border-t bg-background"
        data-testid="transport-bar"
      >
        {/* Step back */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onStep(-1)}
              disabled={atStart}
              aria-label="Step back"
            >
              <SkipBack className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Step back (−1 event)</TooltipContent>
        </Tooltip>

        {/* Play / Pause */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={isPlaying ? onPause : onPlay}
              disabled={eventCount === 0}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
        </Tooltip>

        {/* Step forward */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onStep(1)}
              disabled={atEnd || eventCount === 0}
              aria-label="Step forward"
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Step forward (+1 event)</TooltipContent>
        </Tooltip>

        {/* Scrub slider */}
        <div className="flex-1">
          <Slider
            min={0}
            max={sliderMax}
            step={1}
            value={[sliderValue]}
            onValueChange={handleSliderChange}
            disabled={eventCount === 0}
            aria-label="Scrub timeline"
          />
        </div>

        {/* Event label */}
        <span className="text-xs text-muted-foreground tabular-nums min-w-[80px] text-right">
          {eventLabel}
        </span>
      </div>
    </TooltipProvider>
  );
}
