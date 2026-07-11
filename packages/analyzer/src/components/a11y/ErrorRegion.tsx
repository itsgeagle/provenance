import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * ErrorRegion — an ARIA alert region for error messages. role="alert"
 * implies an assertive live region, so screen readers interrupt and announce
 * content changes immediately (WCAG 4.1.3 Status Messages).
 */
export function ErrorRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn(className)}>
      {children}
    </div>
  );
}
