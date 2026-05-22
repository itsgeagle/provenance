/**
 * Unit tests for diffRoster.
 * Pure function; no DB involved.
 */

import { describe, it, expect } from 'vitest';
import { diffRoster } from './diff.js';
import type { ParsedRow } from './parse.js';
import type { RosterEntry } from '../../db/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RosterEntry> & { id: string; sid: string }): RosterEntry {
  return {
    semester_id: 'sem-1',
    display_name: 'Test User',
    email: null,
    extras: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as RosterEntry;
}

function makeRow(overrides: Partial<ParsedRow> & { sid: string }): ParsedRow {
  return {
    display_name: 'Test User',
    email: null,
    extras: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diffRoster', () => {
  it('returns empty diff for empty inputs', () => {
    const diff = diffRoster([], []);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it('detects additions (CSV has rows not in DB)', () => {
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', display_name: 'Alice' })];
    const diff = diffRoster(parsed, []);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.sid).toBe('12345');
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it('detects deletions (DB has rows not in CSV)', () => {
    const existing: RosterEntry[] = [makeEntry({ id: 'e1', sid: '12345' })];
    const diff = diffRoster([], existing);
    expect(diff.toDelete).toHaveLength(1);
    expect(diff.toDelete[0]?.existingId).toBe('e1');
    expect(diff.toDelete[0]?.sid).toBe('12345');
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('matches by lowercase sid (case-insensitive)', () => {
    const existing: RosterEntry[] = [makeEntry({ id: 'e1', sid: 'ABC123' })];
    const parsed: ParsedRow[] = [makeRow({ sid: 'abc123' })];
    const diff = diffRoster(parsed, existing);
    // sid case changed → update (not add+delete)
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]?.existingId).toBe('e1');
  });

  it('detects update when display_name changes', () => {
    const existing: RosterEntry[] = [makeEntry({ id: 'e1', sid: '12345', display_name: 'Old' })];
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', display_name: 'New' })];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]?.row.display_name).toBe('New');
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it('detects update when email changes', () => {
    const existing: RosterEntry[] = [
      makeEntry({ id: 'e1', sid: '12345', email: 'old@example.com' }),
    ];
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', email: 'new@example.com' })];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
  });

  it('detects update when email changes from null to value', () => {
    const existing: RosterEntry[] = [makeEntry({ id: 'e1', sid: '12345', email: null })];
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', email: 'new@example.com' })];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
  });

  it('detects update when extras changes', () => {
    const existing: RosterEntry[] = [
      makeEntry({ id: 'e1', sid: '12345', extras: { section: '101' } }),
    ];
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', extras: { section: '102' } })];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
  });

  it('does NOT flag update when nothing changed', () => {
    const existing: RosterEntry[] = [
      makeEntry({
        id: 'e1',
        sid: '12345',
        display_name: 'Alice',
        email: 'alice@example.com',
        extras: { section: '101' },
      }),
    ];
    const parsed: ParsedRow[] = [
      makeRow({
        sid: '12345',
        display_name: 'Alice',
        email: 'alice@example.com',
        extras: { section: '101' },
      }),
    ];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it('handles extras equality regardless of object key ordering', () => {
    const existing: RosterEntry[] = [
      makeEntry({ id: 'e1', sid: '12345', extras: { b: '2', a: '1' } }),
    ];
    const parsed: ParsedRow[] = [makeRow({ sid: '12345', extras: { a: '1', b: '2' } })];
    const diff = diffRoster(parsed, existing);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('handles mix of add, update, delete together', () => {
    const existing: RosterEntry[] = [
      makeEntry({ id: 'e1', sid: 'A', display_name: 'Old A' }),
      makeEntry({ id: 'e2', sid: 'B', display_name: 'B unchanged' }),
      makeEntry({ id: 'e3', sid: 'C', display_name: 'C to delete' }),
    ];
    const parsed: ParsedRow[] = [
      makeRow({ sid: 'A', display_name: 'New A' }), // update
      makeRow({ sid: 'B', display_name: 'B unchanged' }), // no change
      makeRow({ sid: 'D', display_name: 'D new' }), // add
    ];
    const diff = diffRoster(parsed, existing);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.sid).toBe('D');
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]?.existingId).toBe('e1');
    expect(diff.toDelete).toHaveLength(1);
    expect(diff.toDelete[0]?.existingId).toBe('e3');
  });
});
