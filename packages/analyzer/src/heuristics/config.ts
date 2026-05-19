/**
 * Default configuration for the v1 heuristics engine (Phase 4).
 *
 * All thresholds are configurable — consumers pass a partial override to
 * runHeuristics(); missing fields fall back to the defaults here.
 *
 * Severity rubric (documented here, enforced in each heuristic):
 *
 *   large_paste:
 *     - medium: ≥200 chars OR ≥10 lines  (configurable via minChars/minLines)
 *     - high:   ≥500 chars OR ≥30 lines  (configurable via highSeverityChars/Lines)
 *     - confidence: 0.8 for non-anomaly pastes (paste detection is reliable);
 *       0.6 when the paste falls inside a paste.anomaly window.
 *
 *   external_edits:
 *     - medium: any unexplained fs.external_change
 *     - high:   unexplained AND |diff_size| > 100 chars AND file is tracked
 *       (configurable via highSeverityCharsChanged)
 *     - confidence: 0.9 for unexplained external changes (hard signal).
 *
 *   low_typing_high_output:
 *     - medium: ratio in [minRatio, highRatio)
 *     - high:   ratio >= highRatio
 *     - confidence: scales with absolute chars_typed → 0..1 mapped over
 *       [0, minCharsForConfidence]. More chars = higher confidence in the ratio.
 *
 *   chain_broken:
 *     - always high, confidence 1.0 (cryptographic check — no ambiguity).
 */

export type HeuristicConfig = {
  largePaste: {
    /** Minimum character count to flag. Default: 200. */
    minChars: number;
    /** Minimum line count to flag. Default: 10. */
    minLines: number;
    /** Character threshold for high severity. Default: 500. */
    highSeverityChars: number;
    /** Line threshold for high severity. Default: 30. */
    highSeverityLines: number;
  };
  externalEdits: {
    /**
     * Maximum gap between consecutive fs.external_change events on the same
     * file (by `t` ms-since-session-start) to coalesce into one flag.
     * Default: 2000ms.
     */
    coalesceWindowMs: number;
    /**
     * |diff_size| threshold for high severity. Only applies when a value is
     * present in the payload. Default: 100 chars.
     */
    highSeverityCharsChanged: number;
  };
  lowTypingHighOutput: {
    /**
     * Minimum ratio (chars_in_final_file / chars_typed) to emit a flag.
     * Ratios below this are treated as normal. Default: 3.
     */
    minRatio: number;
    /**
     * Ratio threshold for high severity. Ratios >= this are high. Default: 5.
     */
    highRatio: number;
    /**
     * chars_typed value at which confidence reaches 1.0. Linearly interpolated
     * from 0 (at 0 chars_typed) to 1.0 (at minCharsForConfidence). Default: 500.
     */
    minCharsForConfidence: number;
  };
};

export const DEFAULT_HEURISTIC_CONFIG: HeuristicConfig = {
  largePaste: {
    minChars: 200,
    minLines: 10,
    highSeverityChars: 500,
    highSeverityLines: 30,
  },
  externalEdits: {
    coalesceWindowMs: 2000,
    highSeverityCharsChanged: 100,
  },
  lowTypingHighOutput: {
    minRatio: 3,
    highRatio: 5,
    minCharsForConfidence: 500,
  },
};

/**
 * Merge a partial config override with the defaults.
 * Nested objects are merged shallowly (per sub-section).
 */
export function mergeConfig(override?: Partial<HeuristicConfig>): HeuristicConfig {
  if (override === undefined) return DEFAULT_HEURISTIC_CONFIG;
  return {
    largePaste: { ...DEFAULT_HEURISTIC_CONFIG.largePaste, ...override.largePaste },
    externalEdits: { ...DEFAULT_HEURISTIC_CONFIG.externalEdits, ...override.externalEdits },
    lowTypingHighOutput: {
      ...DEFAULT_HEURISTIC_CONFIG.lowTypingHighOutput,
      ...override.lowTypingHighOutput,
    },
  };
}
