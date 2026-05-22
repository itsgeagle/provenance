/**
 * SavedViews tests.
 *
 * Tests:
 * 1. Save current filters → appears in dropdown
 * 2. Selecting a saved view calls onLoadView with correct filters+sort
 * 3. Delete removes from localStorage and dropdown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SavedViews, loadSavedViews, addSavedView, deleteSavedView } from './SavedViews.js';
import type { CohortFilters, CohortSort } from '../../api/queries.js';

const TEST_SEMESTER_ID = 'test-semester-001';

function clearStorage() {
  localStorage.removeItem(`provenance:saved-views:${TEST_SEMESTER_ID}`);
}

describe('SavedViews localStorage helpers', () => {
  beforeEach(clearStorage);

  it('loadSavedViews returns [] when nothing stored', () => {
    expect(loadSavedViews(TEST_SEMESTER_ID)).toEqual([]);
  });

  it('addSavedView stores and returns the view', () => {
    const view = {
      name: 'High risk',
      filters: { severityMin: 'high' as const },
      sort: 'score_desc' as CohortSort,
    };
    const result = addSavedView(TEST_SEMESTER_ID, view);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(view);
    expect(loadSavedViews(TEST_SEMESTER_ID)).toHaveLength(1);
  });

  it('addSavedView replaces a view with the same name', () => {
    const first = {
      name: 'My view',
      filters: { scoreMin: 5 },
      sort: 'score_desc' as CohortSort,
    };
    const updated = {
      name: 'My view',
      filters: { scoreMin: 10 },
      sort: 'ingested_desc' as CohortSort,
    };
    addSavedView(TEST_SEMESTER_ID, first);
    const result = addSavedView(TEST_SEMESTER_ID, updated);
    expect(result).toHaveLength(1);
    expect(result[0]!.filters.scoreMin).toBe(10);
  });

  it('deleteSavedView removes the named view', () => {
    addSavedView(TEST_SEMESTER_ID, {
      name: 'A',
      filters: {},
      sort: 'score_desc',
    });
    addSavedView(TEST_SEMESTER_ID, {
      name: 'B',
      filters: {},
      sort: 'score_desc',
    });
    const result = deleteSavedView(TEST_SEMESTER_ID, 'A');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

function renderSavedViews(
  currentFilters: CohortFilters = {},
  currentSort: CohortSort = 'score_desc',
  onLoadView = vi.fn(),
) {
  return render(
    <SavedViews
      semesterId={TEST_SEMESTER_ID}
      currentFilters={currentFilters}
      currentSort={currentSort}
      onLoadView={onLoadView}
    />,
  );
}

describe('SavedViews component', () => {
  beforeEach(() => {
    clearStorage();
    // Reset window.prompt mock after each test
    vi.restoreAllMocks();
  });

  it('shows "Save view" button', () => {
    renderSavedViews();
    expect(screen.getByTestId('save-view-button')).toBeInTheDocument();
  });

  it('saves current filters and shows them in dropdown', async () => {
    // Mock window.prompt
    vi.spyOn(window, 'prompt').mockReturnValue('High risk');

    const filters: CohortFilters = { severityMin: 'high' };
    renderSavedViews(filters);

    fireEvent.click(screen.getByTestId('save-view-button'));

    // Dropdown toggle should appear now that we have a view
    await waitFor(() => {
      expect(screen.getByTestId('saved-views-dropdown-toggle')).toBeInTheDocument();
    });

    // Open the dropdown
    fireEvent.click(screen.getByTestId('saved-views-dropdown-toggle'));

    expect(screen.getByTestId('saved-view-High risk')).toBeInTheDocument();
  });

  it('selecting a saved view calls onLoadView with the stored filters', async () => {
    // Pre-populate storage
    addSavedView(TEST_SEMESTER_ID, {
      name: 'Fails only',
      filters: { validationStatus: 'fail' },
      sort: 'score_desc',
    });

    const onLoadView = vi.fn();
    renderSavedViews({}, 'score_desc', onLoadView);

    // Open dropdown
    fireEvent.click(screen.getByTestId('saved-views-dropdown-toggle'));

    // Click the saved view
    fireEvent.click(screen.getByTestId('saved-view-Fails only'));

    expect(onLoadView).toHaveBeenCalledWith({
      name: 'Fails only',
      filters: { validationStatus: 'fail' },
      sort: 'score_desc',
    });
  });

  it('delete button removes view from dropdown and localStorage', async () => {
    addSavedView(TEST_SEMESTER_ID, {
      name: 'To delete',
      filters: {},
      sort: 'score_desc',
    });
    addSavedView(TEST_SEMESTER_ID, {
      name: 'Keeper',
      filters: {},
      sort: 'score_desc',
    });

    renderSavedViews();

    // Open dropdown
    fireEvent.click(screen.getByTestId('saved-views-dropdown-toggle'));

    // Delete "To delete"
    fireEvent.click(screen.getByTestId('delete-view-To delete'));

    // "To delete" should be gone, "Keeper" should remain
    expect(screen.queryByTestId('saved-view-To delete')).not.toBeInTheDocument();
    expect(screen.getByTestId('saved-view-Keeper')).toBeInTheDocument();

    // Verify localStorage was updated
    const stored = loadSavedViews(TEST_SEMESTER_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe('Keeper');
  });

  it('cancelling the prompt does not save', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    renderSavedViews();
    fireEvent.click(screen.getByTestId('save-view-button'));
    expect(screen.queryByTestId('saved-views-dropdown-toggle')).not.toBeInTheDocument();
    expect(loadSavedViews(TEST_SEMESTER_ID)).toHaveLength(0);
  });
});
