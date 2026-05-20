import { describe, expect, it } from 'vitest';
import { classifyChange, PASTE_MIN_INSERT_CHARS } from './paste-classifier.js';
import type { DocChangeDelta } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyRange(): DocChangeDelta['range'] {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

function nonEmptyRange(): DocChangeDelta['range'] {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
}

function delta(text: string, range = emptyRange()): DocChangeDelta {
  return { text, range };
}

const LONG = 'x'.repeat(PASTE_MIN_INSERT_CHARS);
const SHORT = 'x'.repeat(PASTE_MIN_INSERT_CHARS - 1);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyChange', () => {
  // -------------------------------------------------------------------------
  // Rule 1: single delta ≥ threshold
  // -------------------------------------------------------------------------

  describe('rule 1 — any single delta ≥ threshold', () => {
    it('single delta at empty range with text.length == threshold → paste_likely', () => {
      expect(classifyChange([delta(LONG)])).toBe('paste_likely');
    });

    it('single delta at empty range with text.length > threshold → paste_likely', () => {
      expect(classifyChange([delta('x'.repeat(100))])).toBe('paste_likely');
    });

    it('single delta REPLACEMENT (non-empty range) ≥ threshold → paste_likely (covers tool-applied edits)', () => {
      // Previously classified as 'typed'; now paste_likely so Claude-Code-style
      // single-shot replacements are surfaced as suspicious doc.change events.
      expect(classifyChange([delta(LONG, nonEmptyRange())])).toBe('paste_likely');
    });

    it('multi-delta event where ONE delta is ≥ threshold → paste_likely', () => {
      expect(classifyChange([delta('a'), delta(LONG)])).toBe('paste_likely');
    });

    it('multi-line replacement range with ≥ threshold text → paste_likely', () => {
      const multiLineRange: DocChangeDelta['range'] = {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      };
      expect(classifyChange([delta(LONG, multiLineRange)])).toBe('paste_likely');
    });
  });

  // -------------------------------------------------------------------------
  // Rule 2: aggregate ≥ threshold AND any delta carries a newline
  // -------------------------------------------------------------------------

  describe('rule 2 — multi-delta aggregate ≥ threshold + embedded newline', () => {
    it('multi-delta totaling ≥ threshold with newline in one delta → paste_likely', () => {
      // 15 chars + newline-containing 16-char text = 31 total; embedded newline.
      const a = 'x'.repeat(15);
      const b = 'line1\nline-continued'; // 20 chars including '\n'
      expect(classifyChange([delta(a), delta(b)])).toBe('paste_likely');
    });

    it('multi-delta totaling ≥ threshold WITHOUT any newline → typed (looks like multi-cursor typing)', () => {
      // Two 15-char inserts, single-line each → aggregate 30, but no newline.
      // Heuristic: this shape matches multi-cursor typing, not bulk paste.
      const a = 'x'.repeat(15);
      const b = 'y'.repeat(15);
      expect(classifyChange([delta(a), delta(b)])).toBe('typed');
    });

    it('multi-delta totaling < threshold with newline → typed', () => {
      // Aggregate 6 + 6 = 12 (below threshold) even though newline present.
      expect(classifyChange([delta('hello\n'), delta('world\n')])).toBe('typed');
    });
  });

  // -------------------------------------------------------------------------
  // Below-threshold and degenerate cases
  // -------------------------------------------------------------------------

  it('single delta at empty range with text.length == threshold-1 → typed', () => {
    expect(classifyChange([delta(SHORT)])).toBe('typed');
  });

  it('single delta with text.length == 0 → typed', () => {
    expect(classifyChange([delta('')])).toBe('typed');
  });

  it('empty deltas array → typed', () => {
    expect(classifyChange([])).toBe('typed');
  });

  it('PASTE_MIN_INSERT_CHARS is 30', () => {
    expect(PASTE_MIN_INSERT_CHARS).toBe(30);
  });
});
