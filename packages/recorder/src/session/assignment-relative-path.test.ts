import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { makeAssignmentRelativePath } from './assignment-relative-path.js';

describe('makeAssignmentRelativePath', () => {
  it('computes a path relative to the assignment root, not any outer folder', () => {
    const root = path.join('/ws', '61a', 'cats');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(path.join(root, 'hw.py'))).toBe('hw.py');
    expect(toRelative(path.join(root, 'src', 'main.py'))).toBe(path.join('src', 'main.py'));
  });

  it('matches plain path.relative semantics for the regression case (root == opened folder)', () => {
    const root = path.join('/ws', 'hw03');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(path.join(root, 'hw.py'))).toBe('hw.py');
  });

  it('returns the absolute fsPath unchanged for a file outside the root (mirrors asRelativePath convention)', () => {
    const root = path.join('/ws', '61a', 'cats');
    const outside = path.join('/ws', '61a', 'notes.md');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(outside)).toBe(outside);
  });
});
