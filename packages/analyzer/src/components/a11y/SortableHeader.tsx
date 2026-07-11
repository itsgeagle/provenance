import { cn } from '@/lib/utils';

/**
 * SortableHeader — an accessible, keyboard-operable table column header for
 * sortable tables (WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value).
 *
 * Renders a native <button> inside the <th> so Enter/Space toggle sorting for
 * free, and sets aria-sort on the <th> itself so assistive tech announces the
 * column's current sort state. The visible caret glyph is aria-hidden — the
 * state is conveyed by aria-sort, not the glyph.
 */

export type SortDirection = 'asc' | 'desc' | null;

export interface SortableHeaderProps {
  /** Visible column label, and the button's accessible name unless overridden. */
  label: string;
  /** Current sort state for THIS column. null means the table is not sorted by it. */
  direction: SortDirection;
  /** Toggle handler, invoked when the header button is activated. */
  onSort: () => void;
  /** Applied to the <th>. */
  className?: string;
  /** Optional override for the button's accessible name. */
  'aria-label'?: string;
}

function ariaSortValue(direction: SortDirection): 'ascending' | 'descending' | 'none' {
  if (direction === 'asc') return 'ascending';
  if (direction === 'desc') return 'descending';
  return 'none';
}

export function SortableHeader({
  label,
  direction,
  onSort,
  className,
  'aria-label': ariaLabel,
}: SortableHeaderProps) {
  return (
    <th aria-sort={ariaSortValue(direction)} className={cn(className)}>
      <button
        type="button"
        onClick={onSort}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm font-medium',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        {label}
        <span aria-hidden="true">
          {direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : ''}
        </span>
      </button>
    </th>
  );
}
