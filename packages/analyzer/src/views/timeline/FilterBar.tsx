/**
 * FilterBar — filter controls for the raw timeline view.
 *
 * PRD §7.2 ("Raw timeline").
 *
 * Controls:
 * - Kind filter: multi-select via Radix DropdownMenu (checkbox items).
 *   Selected kinds shown as dismissible Badge chips.
 * - File filter: single-select via DropdownMenu.
 * - Time range: two text Input fields (start/end in ms, matching event.t).
 * - Session filter: single-select dropdown, hidden if only 1 session.
 * - Clear all button when any filter is active.
 */

import { ChevronDown, X } from 'lucide-react';
import type { EventKind } from '@provenance/log-core';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu.js';
import type { TimelineFilters } from './useFilteredEvents.js';
import { DEFAULT_FILTERS } from './useFilteredEvents.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FilterBarProps {
  filters: TimelineFilters;
  onChange: (filters: TimelineFilters) => void;
  /** All distinct event kinds present in the index. */
  availableKinds: EventKind[];
  /** All distinct file paths present in the index. */
  availableFiles: string[];
  /** All distinct session IDs. If length <= 1, session dropdown is hidden. */
  availableSessions: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFiltersActive(filters: TimelineFilters): boolean {
  return (
    filters.kinds.size > 0 ||
    filters.files.size > 0 ||
    filters.timeRangeMs.start !== null ||
    filters.timeRangeMs.end !== null ||
    filters.sessionIds.size > 0
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KindFilter({
  filters,
  availableKinds,
  onChange,
}: {
  filters: TimelineFilters;
  availableKinds: EventKind[];
  onChange: (f: TimelineFilters) => void;
}) {
  const toggleKind = (kind: EventKind) => {
    const next = new Set(filters.kinds);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    onChange({ ...filters, kinds: next });
  };

  const removeKind = (kind: EventKind) => {
    const next = new Set(filters.kinds);
    next.delete(kind);
    onChange({ ...filters, kinds: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            data-testid="kind-filter-trigger"
          >
            Kind
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">Event kinds</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableKinds.map((kind) => (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={filters.kinds.has(kind)}
              onCheckedChange={() => toggleKind(kind)}
              data-testid={`kind-option-${kind}`}
            >
              {kind}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Selected kind chips */}
      {Array.from(filters.kinds).map((kind) => (
        <Badge
          key={kind}
          variant="secondary"
          className="gap-1 text-xs font-normal"
          data-testid={`kind-chip-${kind}`}
        >
          {kind}
          <button
            type="button"
            onClick={() => removeKind(kind)}
            className="ml-0.5 rounded-full hover:bg-muted-foreground/20 focus:outline-none"
            aria-label={`Remove ${kind} filter`}
            data-testid={`kind-chip-remove-${kind}`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function FileFilter({
  filters,
  availableFiles,
  onChange,
}: {
  filters: TimelineFilters;
  availableFiles: string[];
  onChange: (f: TimelineFilters) => void;
}) {
  const selectedFile = filters.files.size > 0 ? Array.from(filters.files)[0]! : '__all__';

  const handleSelect = (value: string) => {
    if (value === '__all__') {
      onChange({ ...filters, files: new Set() });
    } else {
      onChange({ ...filters, files: new Set([value]) });
    }
  };

  const displayLabel =
    selectedFile === '__all__' ? 'All files' : (selectedFile.split('/').pop() ?? selectedFile);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 max-w-[200px] gap-1.5 truncate text-xs"
          data-testid="file-filter-trigger"
          title={selectedFile !== '__all__' ? selectedFile : undefined}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 max-w-[320px] overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Filter by file</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={selectedFile} onValueChange={handleSelect}>
          <DropdownMenuRadioItem value="__all__" data-testid="file-option-all">
            All files
          </DropdownMenuRadioItem>
          {availableFiles.map((file) => (
            <DropdownMenuRadioItem
              key={file}
              value={file}
              className="font-mono text-xs"
              data-testid={`file-option-${file}`}
              title={file}
            >
              <span className="truncate">{file}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TimeRangeFilter({
  filters,
  onChange,
}: {
  filters: TimelineFilters;
  onChange: (f: TimelineFilters) => void;
}) {
  const handleStart = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const val = raw === '' ? null : Number(raw);
    if (val !== null && isNaN(val)) return; // reject non-numeric input
    onChange({ ...filters, timeRangeMs: { ...filters.timeRangeMs, start: val } });
  };

  const handleEnd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const val = raw === '' ? null : Number(raw);
    if (val !== null && isNaN(val)) return;
    onChange({ ...filters, timeRangeMs: { ...filters.timeRangeMs, end: val } });
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">t(ms):</span>
      <Input
        type="number"
        placeholder="Start"
        value={filters.timeRangeMs.start ?? ''}
        onChange={handleStart}
        className="h-8 w-24 text-xs"
        data-testid="time-start-input"
        aria-label="Time range start (ms)"
        min={0}
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="number"
        placeholder="End"
        value={filters.timeRangeMs.end ?? ''}
        onChange={handleEnd}
        className="h-8 w-24 text-xs"
        data-testid="time-end-input"
        aria-label="Time range end (ms)"
        min={0}
      />
    </div>
  );
}

function SessionFilter({
  filters,
  availableSessions,
  onChange,
}: {
  filters: TimelineFilters;
  availableSessions: string[];
  onChange: (f: TimelineFilters) => void;
}) {
  if (availableSessions.length <= 1) return null;

  const selected = filters.sessionIds.size > 0 ? Array.from(filters.sessionIds)[0]! : '__all__';

  const handleSelect = (value: string) => {
    if (value === '__all__') {
      onChange({ ...filters, sessionIds: new Set() });
    } else {
      onChange({ ...filters, sessionIds: new Set([value]) });
    }
  };

  const displayLabel = selected === '__all__' ? 'All sessions' : `Session ${selected.slice(0, 8)}…`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 font-mono text-xs"
          data-testid="session-filter-trigger"
        >
          {displayLabel}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">Filter by session</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={selected} onValueChange={handleSelect}>
          <DropdownMenuRadioItem value="__all__">All sessions</DropdownMenuRadioItem>
          {availableSessions.map((sid) => (
            <DropdownMenuRadioItem
              key={sid}
              value={sid}
              className="font-mono text-xs"
              data-testid={`session-option-${sid}`}
            >
              {sid.slice(0, 8)}…
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export function FilterBar({
  filters,
  onChange,
  availableKinds,
  availableFiles,
  availableSessions,
}: FilterBarProps) {
  const handleClearAll = () => onChange(DEFAULT_FILTERS);

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-2.5"
      data-testid="filter-bar"
    >
      {/* Kind filter */}
      <KindFilter filters={filters} availableKinds={availableKinds} onChange={onChange} />

      {/* File filter */}
      {availableFiles.length > 0 && (
        <FileFilter filters={filters} availableFiles={availableFiles} onChange={onChange} />
      )}

      {/* Session filter (multi-session bundles only) */}
      <SessionFilter filters={filters} availableSessions={availableSessions} onChange={onChange} />

      {/* Time range */}
      <TimeRangeFilter filters={filters} onChange={onChange} />

      {/* Clear all */}
      {isFiltersActive(filters) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground hover:text-foreground"
          onClick={handleClearAll}
          data-testid="clear-filters-btn"
        >
          Clear all
        </Button>
      )}
    </div>
  );
}
