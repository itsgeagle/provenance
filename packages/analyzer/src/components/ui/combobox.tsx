/**
 * Combobox — searchable single-select with keyboard navigation.
 *
 * Plain <input> + filtered popup list. No new dep; built on Input.
 *
 * - `filter='client'` filters `options` against the typed query.
 * - `filter='none'` is a pass-through; the caller drives filtering via
 *   `onQueryChange` (typically a debounced server search).
 *
 * Selection is single-value. The popup opens on focus/typing and closes on
 * blur / Escape / selection. Arrow keys + Enter navigate.
 */

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input.js';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional secondary text, shown dimmed after the label. Also matched by the client filter. */
  secondary?: string;
  /** Optional inline marker shown on the right (e.g. "existing submission"). */
  badge?: string;
  badgeTone?: 'default' | 'warn';
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** Controlled query (required when `filter='none'`). */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** 'client' = filter `options` by `query`; 'none' = trust caller. Default 'client'. */
  filter?: 'client' | 'none';
  placeholder?: string;
  emptyText?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Optional id on the underlying input for label association. */
  id?: string;
  /** Optional className on the outer wrapper. */
  className?: string;
  'data-testid'?: string;
}

function matchesQuery(opt: ComboboxOption, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  if (opt.label.toLowerCase().includes(needle)) return true;
  if (opt.secondary && opt.secondary.toLowerCase().includes(needle)) return true;
  return false;
}

export function Combobox({
  value,
  onChange,
  options,
  query: queryProp,
  onQueryChange,
  filter = 'client',
  placeholder,
  emptyText = 'No matches',
  loading = false,
  disabled = false,
  id,
  className,
  'data-testid': dataTestId,
}: ComboboxProps) {
  const isControlledQuery = queryProp !== undefined;
  const [internalQuery, setInternalQuery] = React.useState('');
  const query = isControlledQuery ? queryProp : internalQuery;

  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const selected = React.useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  // Show the selected option's label as the input text when the popup is
  // closed and the user hasn't typed anything. When the popup is open we let
  // the user type freely (their query is what's shown).
  const displayValue = open ? query : (selected?.label ?? query);

  const filtered = React.useMemo(() => {
    if (filter === 'none') return options;
    return options.filter((o) => matchesQuery(o, query));
  }, [options, query, filter]);

  // Reset highlight when the visible list changes.
  React.useEffect(() => {
    setHighlight(0);
  }, [filtered.length, open]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row scrolled into view.
  React.useEffect(() => {
    if (!open) return;
    const ul = listRef.current;
    if (!ul) return;
    const el = ul.children.item(highlight) as HTMLElement | null;
    // scrollIntoView is missing in JSDOM, hence the typeof guard.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, open]);

  function setQuery(next: string) {
    if (!isControlledQuery) setInternalQuery(next);
    onQueryChange?.(next);
  }

  function select(opt: ComboboxOption) {
    onChange(opt.value);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault();
        select(filtered[highlight]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    }
  }

  const listboxId = id ? `${id}-listbox` : undefined;

  return (
    <div ref={rootRef} className={cn('relative', className)} data-testid={dataTestId}>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="pr-8"
        />
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-input bg-popover py-1 text-sm shadow-md"
        >
          {loading && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">
              Loading…
            </li>
          )}
          {!loading && filtered.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">{emptyText}</li>
          )}
          {!loading &&
            filtered.map((opt, i) => {
              const isSelected = opt.value === value;
              const isHighlighted = i === highlight;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`combobox-option-${opt.value}`}
                  onMouseDown={(e) => {
                    // Use mousedown to fire before the input's blur, which
                    // would otherwise close the popup and cancel the click.
                    e.preventDefault();
                    select(opt);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                    isHighlighted && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Check
                    aria-hidden
                    className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="truncate">{opt.label}</span>
                  {opt.secondary && (
                    <span className="truncate text-xs text-muted-foreground">{opt.secondary}</span>
                  )}
                  {opt.badge && (
                    <span
                      className={cn(
                        'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        opt.badgeTone === 'warn'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-gray-100 text-gray-700',
                      )}
                    >
                      {opt.badge}
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
