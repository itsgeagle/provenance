import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * RowLink — a keyboard-reachable drill-in control for table rows (WCAG 2.1.1
 * Keyboard, 4.1.2 Name/Role/Value).
 *
 * Consumers place <RowLink> around the primary cell's content, NOT on the
 * <tr> itself, so the row's drill-in action is a real, focusable <a> element
 * rather than a mouse-only onClick on a non-interactive row.
 */
export function RowLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
    >
      {children}
    </Link>
  );
}
