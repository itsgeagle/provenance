/**
 * Pure buffer-flush decision function.
 * PRD §4.7: "flush to disk every 1 s or 256 KB, whichever comes first."
 *
 * No state, no I/O — pure decision from inputs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BufferPolicyInput = {
  bufferedBytes: number;
  /** Monotonic timestamp (ms) of the last flush. */
  lastFlushAtMs: number;
  /** Current monotonic timestamp (ms). */
  nowMs: number;
};

export type BufferPolicyConfig = {
  /** Flush when buffered bytes reach or exceed this. Default: 256 KiB. */
  maxBytes: number;
  /** Flush when ms since last flush reaches or exceeds this. Default: 1000. */
  maxIntervalMs: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BUFFER_POLICY: BufferPolicyConfig = {
  maxBytes: 256 * 1024,
  maxIntervalMs: 1000,
};

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Returns true if the buffer should be flushed now.
 *
 * Rules:
 *  - bufferedBytes === 0 → never flush (no point writing an empty buffer).
 *  - bufferedBytes >= maxBytes → flush (size threshold reached or exceeded).
 *  - (nowMs - lastFlushAtMs) >= maxIntervalMs → flush (time threshold reached or exceeded).
 */
export function shouldFlush(
  input: BufferPolicyInput,
  config?: Partial<BufferPolicyConfig>,
): boolean {
  const { maxBytes, maxIntervalMs } = { ...DEFAULT_BUFFER_POLICY, ...config };
  const { bufferedBytes, lastFlushAtMs, nowMs } = input;

  // Never flush an empty buffer.
  if (bufferedBytes === 0) {
    return false;
  }

  // Size threshold.
  if (bufferedBytes >= maxBytes) {
    return true;
  }

  // Time threshold.
  if (nowMs - lastFlushAtMs >= maxIntervalMs) {
    return true;
  }

  return false;
}
