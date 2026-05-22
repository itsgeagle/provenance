/**
 * Roster diff (PRD §8.4).
 *
 * Pure function. Computes add / update / delete sets given the current
 * roster_entries rows and a freshly parsed CSV result.
 *
 * Matching is by lowercase sid (case-insensitive).
 * An entry is "updated" if any of sid, display_name, email, or extras
 * differs from the existing row.
 */

import type { ParsedRow } from './parse.js';
import type { RosterEntry } from '../../db/schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RosterDiff {
  toAdd: ParsedRow[];
  toUpdate: { existingId: string; row: ParsedRow }[];
  toDelete: { existingId: string; sid: string }[];
}

// ---------------------------------------------------------------------------
// diffRoster
// ---------------------------------------------------------------------------

/**
 * Compute the diff between parsed CSV rows and existing DB rows.
 *
 * @param parsed   - Rows from parseRosterCsv.
 * @param existing - Rows from the database.
 * @returns RosterDiff with toAdd, toUpdate, and toDelete sets.
 */
export function diffRoster(parsed: ParsedRow[], existing: RosterEntry[]): RosterDiff {
  // Build a map from lowercase sid → existing row.
  const existingBySid = new Map<string, RosterEntry>();
  for (const row of existing) {
    existingBySid.set(row.sid.toLowerCase(), row);
  }

  const toAdd: ParsedRow[] = [];
  const toUpdate: { existingId: string; row: ParsedRow }[] = [];
  const seenSids = new Set<string>();

  for (const parsedRow of parsed) {
    const key = parsedRow.sid.toLowerCase();
    seenSids.add(key);

    const existing = existingBySid.get(key);
    if (existing === undefined) {
      toAdd.push(parsedRow);
    } else {
      // Check if any field changed.
      if (hasChanged(existing, parsedRow)) {
        toUpdate.push({ existingId: existing.id, row: parsedRow });
      }
    }
  }

  // Rows in DB but not in CSV → deletions.
  const toDelete: { existingId: string; sid: string }[] = [];
  for (const [key, existing] of existingBySid) {
    if (!seenSids.has(key)) {
      toDelete.push({ existingId: existing.id, sid: existing.sid });
    }
  }

  return { toAdd, toUpdate, toDelete };
}

// ---------------------------------------------------------------------------
// hasChanged — compare parsed row against existing DB row
// ---------------------------------------------------------------------------

function hasChanged(existing: RosterEntry, parsed: ParsedRow): boolean {
  // sid comparison is case-insensitive; if case differs, treat as changed
  // so we normalize it in the DB on update.
  if (existing.sid !== parsed.sid) return true;
  if (existing.display_name !== parsed.display_name) return true;
  // email: null vs null is equal; string equality otherwise.
  if (existing.email !== parsed.email) return true;
  // extras: deep equality via JSON serialization (object, order-insensitive).
  const existingExtras = (existing.extras as Record<string, string> | null) ?? {};
  if (!extrasEqual(existingExtras, parsed.extras)) return true;
  return false;
}

function extrasEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (a[keysA[i]!] !== b[keysA[i]!]) return false;
  }
  return true;
}
