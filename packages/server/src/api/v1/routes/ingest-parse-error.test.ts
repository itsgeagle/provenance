/**
 * Unit tests for isUnbufferableBodyError (Phase 0 diagnostics fix).
 *
 * Regression guard: a multi-GB upload trips a ~2 GiB-class allocation ceiling
 * inside Node's FormData/undici multipart parser. Before this fix the route's
 * bare `catch {}` reported a misleading 400 "Request validation failed"; the
 * detector lets the route return an actionable 413 instead. Pure function, so
 * tested in isolation from the (testcontainer-backed) route wiring.
 */

import { describe, it, expect } from 'vitest';
import { isUnbufferableBodyError } from './ingest.js';

describe('isUnbufferableBodyError', () => {
  it('matches the V8/undici oversized-allocation RangeErrors', () => {
    for (const message of [
      'Array buffer allocation failed',
      'Invalid typed array length: 2147483648',
      'Cannot create a string longer than 0x1fffffe8 characters',
      'Invalid string length',
    ]) {
      expect(isUnbufferableBodyError(new RangeError(message))).toBe(true);
    }
  });

  it('matches an out-of-memory error regardless of error subtype', () => {
    expect(isUnbufferableBodyError(new Error('Process out of memory'))).toBe(true);
  });

  it('does not match a genuinely malformed-body parse error', () => {
    expect(isUnbufferableBodyError(new Error('Malformed part header'))).toBe(false);
    expect(isUnbufferableBodyError(new TypeError('Unexpected end of form'))).toBe(false);
  });

  it('does not match non-Error throwables', () => {
    expect(isUnbufferableBodyError('Array buffer allocation failed')).toBe(false);
    expect(isUnbufferableBodyError(undefined)).toBe(false);
    expect(isUnbufferableBodyError(null)).toBe(false);
  });
});
