/**
 * Format utilities for the analyzer UI.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Rules:
 *   >= 1 hour  → "1h 23m"
 *   >= 1 min   → "45m 12s"
 *   < 1 min    → "12s"
 *   0 or < 0   → "0s"
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
