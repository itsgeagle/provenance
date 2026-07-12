import { describe, it, expect } from 'vitest';
import { isTransientDbError } from './transient-error.js';

describe('isTransientDbError', () => {
  it('flags "too many clients" by SQLSTATE code', () => {
    expect(isTransientDbError(Object.assign(new Error('x'), { code: '53300' }))).toBe(true);
  });

  it('flags connection-exception SQLSTATEs and connection-level codes', () => {
    expect(isTransientDbError(Object.assign(new Error(), { code: '08006' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error(), { code: '57P03' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error(), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error(), { code: 'CONNECTION_ENDED' }))).toBe(true);
  });

  it('walks the cause chain (Drizzle wraps the driver error)', () => {
    const driver = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    const wrapped = Object.assign(new Error('Failed query: select ...'), { cause: driver });
    expect(isTransientDbError(wrapped)).toBe(true);
  });

  it('matches on message text when the code was lost in re-wrapping', () => {
    // The per-phase ingest handlers rebuild an Error from only e.message.
    expect(isTransientDbError(new Error('compute_stats: sorry, too many clients already'))).toBe(
      true,
    );
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('does NOT flag permanent / data errors', () => {
    // unique_violation — a real, non-retryable failure.
    expect(isTransientDbError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isTransientDbError(new Error('invalid_manifest: bad signature'))).toBe(false);
    expect(isTransientDbError(new Error('no student match'))).toBe(false);
  });

  it('is safe on non-error inputs', () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError('too many clients')).toBe(false); // bare string, not an error object
    expect(isTransientDbError(42)).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { code?: string; cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(isTransientDbError(a)).toBe(false);
  });
});
