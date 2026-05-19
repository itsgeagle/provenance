/**
 * SeverityChip — displays flag severity with appropriate color.
 *
 * Renders a styled badge with severity-specific colors:
 * - info: gray
 * - low: blue
 * - medium: amber
 * - high: red
 */

import { cn } from '@/lib/utils';
import type { Severity } from '@/heuristics/types';

const SEVERITY_CLASSES: Record<Severity, string> = {
  info: 'bg-gray-100 text-gray-700 border-gray-200',
  low: 'bg-blue-100 text-blue-700 border-blue-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  high: 'bg-red-100 text-red-700 border-red-200',
};

type SeverityChipProps = {
  severity: Severity;
  className?: string;
  'data-testid'?: string;
};

export function SeverityChip({ severity, className, 'data-testid': testid }: SeverityChipProps) {
  return (
    <span
      data-testid={testid ?? `severity-chip-${severity}`}
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        SEVERITY_CLASSES[severity],
        className,
      )}
    >
      {severity.toUpperCase()}
    </span>
  );
}
