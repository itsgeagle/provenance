/**
 * Result type for expected errors.
 * CLAUDE.md: "Errors are values when expected (return a Result<T, E> or a discriminated union)."
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
