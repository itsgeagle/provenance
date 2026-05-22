/**
 * SavedViews — localStorage-backed saved filter+sort views.
 *
 * Storage key: `provenance:saved-views:<semesterId>`
 * Stored shape: SavedView[] JSON array
 *
 * Features:
 * - Dropdown listing saved view names
 * - "Save current view" button → prompts for name, writes to localStorage
 * - Selecting a view loads its filters+sort into URL (calls onLoadView)
 * - "Delete" button per saved view
 */

import { useState } from 'react';
import type { CohortFilters, CohortSort } from '../../api/queries.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SavedView = {
  name: string;
  filters: CohortFilters;
  sort: CohortSort;
};

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function storageKey(semesterId: string): string {
  return `provenance:saved-views:${semesterId}`;
}

export function loadSavedViews(semesterId: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(semesterId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedView[];
  } catch {
    return [];
  }
}

export function writeSavedViews(semesterId: string, views: SavedView[]): void {
  localStorage.setItem(storageKey(semesterId), JSON.stringify(views));
}

export function addSavedView(semesterId: string, view: SavedView): SavedView[] {
  const existing = loadSavedViews(semesterId);
  // Replace if same name
  const filtered = existing.filter((v) => v.name !== view.name);
  const next = [...filtered, view];
  writeSavedViews(semesterId, next);
  return next;
}

export function deleteSavedView(semesterId: string, name: string): SavedView[] {
  const existing = loadSavedViews(semesterId);
  const next = existing.filter((v) => v.name !== name);
  writeSavedViews(semesterId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SavedViewsProps {
  semesterId: string;
  currentFilters: CohortFilters;
  currentSort: CohortSort;
  onLoadView: (view: SavedView) => void;
}

export function SavedViews({
  semesterId,
  currentFilters,
  currentSort,
  onLoadView,
}: SavedViewsProps) {
  const [views, setViews] = useState<SavedView[]>(() => loadSavedViews(semesterId));
  const [isOpen, setIsOpen] = useState(false);

  function handleSaveCurrent() {
    const name = window.prompt('Save view as:')?.trim();
    if (!name) return;
    const next = addSavedView(semesterId, {
      name,
      filters: currentFilters,
      sort: currentSort,
    });
    setViews(next);
  }

  function handleDelete(name: string) {
    const next = deleteSavedView(semesterId, name);
    setViews(next);
  }

  function handleSelect(view: SavedView) {
    onLoadView(view);
    setIsOpen(false);
  }

  return (
    <div className="relative" data-testid="saved-views">
      <div className="flex items-center gap-2">
        {/* Save button */}
        <button
          onClick={handleSaveCurrent}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          data-testid="save-view-button"
        >
          Save view
        </button>

        {/* Dropdown toggle */}
        {views.length > 0 && (
          <button
            onClick={() => setIsOpen((v) => !v)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            data-testid="saved-views-dropdown-toggle"
          >
            Saved views ({views.length}) ▾
          </button>
        )}
      </div>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          data-testid="saved-views-panel"
        >
          {views.map((view) => (
            <div
              key={view.name}
              className="flex items-center justify-between px-3 py-2 hover:bg-gray-50"
            >
              <button
                className="flex-1 text-left text-sm text-gray-700"
                onClick={() => handleSelect(view)}
                data-testid={`saved-view-${view.name}`}
              >
                {view.name}
              </button>
              <button
                className="ml-2 text-xs text-red-500 hover:text-red-700"
                onClick={() => handleDelete(view.name)}
                data-testid={`delete-view-${view.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
