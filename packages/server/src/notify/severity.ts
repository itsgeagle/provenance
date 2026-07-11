/**
 * Severity levels for operational notifications, ordered least to most urgent.
 */
export type Severity = 'info' | 'warn' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

/**
 * Returns true when `evt`'s severity is at or above the `min` threshold.
 * Used to gate whether a given event reaches a given sink.
 */
export function meets(evt: Severity, min: Severity): boolean {
  return SEVERITY_ORDER[evt] >= SEVERITY_ORDER[min];
}
