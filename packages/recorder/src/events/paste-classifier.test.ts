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
  it('single delta at empty range with text.length == 30 → paste_likely', () => {
    expect(classifyChange([delta(LONG)])).toBe('paste_likely');
  });

  it('single delta at empty range with text.length > 30 → paste_likely', () => {
    expect(classifyChange([delta('x'.repeat(100))])).toBe('paste_likely');
  });

  it('single delta at empty range with text.length == 29 → typed', () => {
    expect(classifyChange([delta(SHORT)])).toBe('typed');
  });

  it('single delta at empty range with text.length == 0 → typed', () => {
    expect(classifyChange([delta('')])).toBe('typed');
  });

  it('single insert with non-empty range (deletion present) → typed', () => {
    expect(classifyChange([delta(LONG, nonEmptyRange())])).toBe('typed');
  });

  it('multiple deltas → typed regardless of size', () => {
    expect(classifyChange([delta(LONG), delta(LONG)])).toBe('typed');
  });

  it('empty deltas array → typed', () => {
    expect(classifyChange([])).toBe('typed');
  });

  it('multiline range (even zero-char delta at same position) → typed if deletions implied', () => {
    const multiLineRange: DocChangeDelta['range'] = {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 }, // spans a line → deletion
    };
    expect(classifyChange([delta(LONG, multiLineRange)])).toBe('typed');
  });

  it('PASTE_MIN_INSERT_CHARS is 30', () => {
    expect(PASTE_MIN_INSERT_CHARS).toBe(30);
  });
});
