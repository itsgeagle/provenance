/**
 * LoadingPanel — displays the current loading stage during bundle processing.
 *
 * v1: a spinner with a stage label is enough. Fine-grained percent-progress
 * within a stage is not required.
 */

import type { LoadingStage } from '../../context/BundleContext.js';

const STAGE_LABELS: Record<NonNullable<LoadingStage>, string> = {
  unzip: 'Reading ZIP file…',
  index: 'Building event index…',
  validate: 'Running validation…',
  heuristics: 'Running heuristics…',
};

interface LoadingPanelProps {
  stage: LoadingStage;
}

export function LoadingPanel({ stage }: LoadingPanelProps) {
  const label = stage !== null ? STAGE_LABELS[stage] : 'Loading…';

  return (
    <div
      data-testid="loading-panel"
      className="flex flex-col items-center gap-4 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {/* Spinner */}
      <svg
        className="h-10 w-10 animate-spin text-primary"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>

      <p data-testid="loading-stage-label" className="text-sm font-medium">
        {label}
      </p>
    </div>
  );
}
