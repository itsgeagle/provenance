import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * StatusRegion — a polite ARIA live region for transient, non-critical status
 * updates (e.g. "Loading…"). Screen readers announce content changes inside
 * this region without interrupting the user (WCAG 4.1.3 Status Messages).
 */
export function StatusRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn(className)}>
      {children}
    </div>
  );
}
