/**
 * Tests for ExpectedContentRegistry.
 */

import { describe, expect, it } from 'vitest';
import { ExpectedContentRegistry } from './expected-content-registry.js';

describe('ExpectedContentRegistry', () => {
  it('getOrCreate returns same instance for same path', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py']);
    const ec1 = reg.getOrCreate('src/foo.py', 'hello');
    const ec2 = reg.getOrCreate('src/foo.py', 'something else');
    expect(ec1).toBe(ec2);
    // Content should be from first construction, not overwritten
    expect(ec1.content).toBe('hello');
  });

  it('get returns undefined for unknown path', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py']);
    expect(reg.get('not/there.py')).toBeUndefined();
  });

  it('get returns the entry after getOrCreate', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py']);
    const ec = reg.getOrCreate('src/foo.py', 'content');
    expect(reg.get('src/foo.py')).toBe(ec);
  });

  it('delete removes entry; get returns undefined after delete', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py']);
    reg.getOrCreate('src/foo.py', 'content');
    reg.delete('src/foo.py');
    expect(reg.get('src/foo.py')).toBeUndefined();
  });

  it('isWatched is true for paths in the list', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py', 'src/bar.py']);
    expect(reg.isWatched('src/foo.py')).toBe(true);
    expect(reg.isWatched('src/bar.py')).toBe(true);
  });

  it('isWatched is false for paths not in the list', () => {
    const reg = new ExpectedContentRegistry(['src/foo.py']);
    expect(reg.isWatched('src/other.py')).toBe(false);
    expect(reg.isWatched('')).toBe(false);
  });

  it('can track multiple files independently', () => {
    const reg = new ExpectedContentRegistry(['a.py', 'b.py']);
    const a = reg.getOrCreate('a.py', 'aaa');
    const b = reg.getOrCreate('b.py', 'bbb');
    expect(a).not.toBe(b);
    expect(a.content).toBe('aaa');
    expect(b.content).toBe('bbb');
  });
});
