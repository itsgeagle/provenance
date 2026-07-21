import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveOwnerRoot } from './session-router.js';

describe('resolveOwnerRoot', () => {
  const cats = path.join('/ws', '61a', 'cats');
  const hog = path.join('/ws', '61a', 'hog');
  const roots = [cats, hog];

  it('routes a file under one root to that root only', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), roots)).toBe(cats);
  });

  it('routes a file under a sibling root to that root, not the first one', () => {
    expect(resolveOwnerRoot(path.join(hog, 'y.py'), roots)).toBe(hog);
  });

  it('returns null for a file owned by no root', () => {
    expect(resolveOwnerRoot(path.join('/ws', '61a', 'notes.md'), roots)).toBeNull();
  });

  it('does not treat a sibling with a shared string prefix as owned', () => {
    // "cats-extra" starts with the string "cats" but is not inside the cats/ directory.
    const catsExtra = path.join('/ws', '61a', 'cats-extra');
    expect(resolveOwnerRoot(path.join(catsExtra, 'z.py'), roots)).toBeNull();
  });

  it('nearest-enclosing manifest wins for a nested case', () => {
    const catsNested = path.join(cats, 'subproj');
    const nestedRoots = [cats, catsNested];
    expect(resolveOwnerRoot(path.join(catsNested, 'a.py'), nestedRoots)).toBe(catsNested);
    expect(resolveOwnerRoot(path.join(cats, 'b.py'), nestedRoots)).toBe(cats);
  });

  it('a path equal to the root itself is owned by that root', () => {
    expect(resolveOwnerRoot(cats, roots)).toBe(cats);
  });

  it('returns null when there are no roots at all', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), [])).toBeNull();
  });
});
