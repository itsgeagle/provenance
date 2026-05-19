import { describe, it, expect } from 'vitest';
import { ok, err } from './result.js';
import type { Result } from './result.js';

describe('Result', () => {
  it('ok() creates a successful Result with the given value', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it('err() creates a failed Result with the given error', () => {
    const r = err('something went wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('something went wrong');
    }
  });

  it('ok() Result does not have an error field', () => {
    const r: Result<number, string> = ok(1);
    expect(r.ok).toBe(true);
    // narrowing: the error field should not exist
    if (r.ok) {
      expect('error' in r).toBe(false);
    }
  });

  it('err() Result does not have a value field', () => {
    const r: Result<number, string> = err('oops');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect('value' in r).toBe(false);
    }
  });

  it('works with complex types', () => {
    type MyError = { code: number; message: string };
    const r: Result<{ id: string }, MyError> = err({ code: 404, message: 'not found' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(404);
    }
  });
});
