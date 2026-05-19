/**
 * Tests for ExpectedContent — in-memory file content model + SHA-256.
 * PRD §4.5: foundation for external-change detection.
 */

import { describe, expect, it } from 'vitest';
import { ExpectedContent } from './expected-content.js';

// ---------------------------------------------------------------------------
// Hash correctness (pinned test vector from progress.md)
// ---------------------------------------------------------------------------

describe('ExpectedContent – hash', () => {
  it('returns sha256 of initial content (pinned vector)', () => {
    const ec = new ExpectedContent('hello world');
    expect(ec.hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('hash updates after applyDelta', () => {
    const ec = new ExpectedContent('hello world');
    const initialHash = ec.hash;
    ec.applyDelta({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      text: 'X',
    });
    expect(ec.hash).not.toBe(initialHash);
  });

  it('hash updates after reset', () => {
    const ec = new ExpectedContent('hello world');
    const initialHash = ec.hash;
    ec.reset('goodbye');
    expect(ec.hash).not.toBe(initialHash);
  });

  it('memoizes hash between modifications', () => {
    const ec = new ExpectedContent('hello world');
    const h1 = ec.hash;
    const h2 = ec.hash;
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// content access
// ---------------------------------------------------------------------------

describe('ExpectedContent – content', () => {
  it('returns initial content', () => {
    const ec = new ExpectedContent('abc');
    expect(ec.content).toBe('abc');
  });

  it('reflects insert at offset 0', () => {
    const ec = new ExpectedContent('hello');
    ec.applyDelta({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      text: 'X',
    });
    expect(ec.content).toBe('Xhello');
  });

  it('reflects replacement of a range', () => {
    const ec = new ExpectedContent('hello world');
    // Replace 'world' (chars 6-11) with 'there'
    ec.applyDelta({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      text: 'there',
    });
    expect(ec.content).toBe('hello there');
  });

  it('reflects deletion (empty text)', () => {
    const ec = new ExpectedContent('hello');
    ec.applyDelta({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      text: '',
    });
    expect(ec.content).toBe('lo');
  });

  it('reset replaces content', () => {
    const ec = new ExpectedContent('old content');
    ec.reset('new content');
    expect(ec.content).toBe('new content');
  });
});

// ---------------------------------------------------------------------------
// lineCount
// ---------------------------------------------------------------------------

describe('ExpectedContent – lineCount', () => {
  it('empty string → 0', () => {
    expect(new ExpectedContent('').lineCount).toBe(0);
  });

  it('"abc" → 1', () => {
    expect(new ExpectedContent('abc').lineCount).toBe(1);
  });

  it('"abc\\ndef" → 2', () => {
    expect(new ExpectedContent('abc\ndef').lineCount).toBe(2);
  });

  it('"abc\\n" → 2 (trailing newline counts empty line)', () => {
    expect(new ExpectedContent('abc\n').lineCount).toBe(2);
  });

  it('"\\n\\n" → 3', () => {
    expect(new ExpectedContent('\n\n').lineCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyDeltas (ordered)
// ---------------------------------------------------------------------------

describe('ExpectedContent – applyDeltas', () => {
  it('applies multiple deltas in order', () => {
    const ec = new ExpectedContent('abc');
    ec.applyDeltas([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'X' },
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, text: 'Y' },
    ]);
    // After first: 'Xabc'; after second: 'XabcY'
    expect(ec.content).toBe('XabcY');
  });

  it('applying zero deltas is a no-op', () => {
    const ec = new ExpectedContent('hello');
    const hashBefore = ec.hash;
    ec.applyDeltas([]);
    expect(ec.content).toBe('hello');
    expect(ec.hash).toBe(hashBefore);
  });
});

// ---------------------------------------------------------------------------
// Range edge cases
// ---------------------------------------------------------------------------

describe('ExpectedContent – range edge cases', () => {
  it('position at end-of-line inserts before newline', () => {
    const ec = new ExpectedContent('ab\ncd');
    // character 2 on line 0 = position just before \n
    ec.applyDelta({
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
      text: 'X',
    });
    expect(ec.content).toBe('abX\ncd');
  });

  it('position at end-of-document inserts at end', () => {
    const ec = new ExpectedContent('abc');
    ec.applyDelta({
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
      text: '!',
    });
    expect(ec.content).toBe('abc!');
  });

  it('character beyond line length clamps to end of line', () => {
    const ec = new ExpectedContent('abc');
    // character 999 on line 0 clamps to 3
    ec.applyDelta({
      range: { start: { line: 0, character: 999 }, end: { line: 0, character: 999 } },
      text: '!',
    });
    expect(ec.content).toBe('abc!');
  });

  it('multi-line delta replaces across lines', () => {
    const ec = new ExpectedContent('line1\nline2\nline3');
    // Replace from end of line 0 char 5 to end of line 1 char 5
    ec.applyDelta({
      range: { start: { line: 0, character: 5 }, end: { line: 1, character: 5 } },
      text: '-replaced-',
    });
    expect(ec.content).toBe('line1-replaced-\nline3');
  });
});
