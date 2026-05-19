/**
 * low_typing_high_output heuristic (Phase 4).
 *
 * PRD §7.4: "Output far exceeds typed input — (chars saved in final file) /
 * (chars typed via doc.change inserts) > 3."
 *
 * Emits one Flag per offending file. The ratio is computed per file (not at
 * the bundle level) because different files may have very different ratios
 * for legitimate reasons.
 *
 * "chars in final file" = length of the reconstructed final content.
 * "chars typed" = sum of inserted character counts from doc.change events
 *   (stats.charsTyped for that file).
 *
 * Skips any file whose reconstruction is tainted (reconstructFile set
 * tainted=true due to fs.external_change or a large paste > 4 KB with no
 * inline content). In that case the chars_in_final_file cannot be reliably
 * computed, so the ratio check is not meaningful. The skip is recorded in
 * the detail field of any flag for the file (though we don't emit a flag for
 * skipped files — we only emit flags for files that trigger the ratio).
 *
 * Severity by ratio bracket:
 *   - medium: ratio in [minRatio, highRatio)  (default: [3, 5))
 *   - high:   ratio >= highRatio              (default: >= 5)
 *
 * Confidence:
 *   Linearly interpolated from 0 (at 0 chars_typed) to 1.0 (at
 *   minCharsForConfidence chars_typed). More characters → more reliable ratio.
 *   Clamped to [0, 1].
 *
 * Edge cases:
 *   - chars_typed = 0 AND final content is non-empty → ratio is effectively
 *     infinite. We emit a high-severity flag with confidence proportional to
 *     the final content length / minCharsForConfidence (also clamped to 1).
 *   - final content is empty → no flag (nothing to flag; user typed some but
 *     there's nothing in the file).
 *   - tainted reconstruction → skip (no flag).
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';
import { computeStats } from '../index/stats.js';
import { reconstructFile } from '../index/reconstruct-file.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function flagId(filePath: string, index: number): string {
  // Sanitize file path for use in an id: replace non-alphanum with '-'.
  const sanitized = filePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  return `low_typing_high_output-${sanitized}-${index}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { minRatio, highRatio, minCharsForConfidence } = config.lowTypingHighOutput;

  const bundleStats = computeStats(index);

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [filePath, fileStats] of bundleStats.perFile) {
    // Skip tainted files — reconstruction is unreliable.
    if (fileStats.reconstructionTainted) continue;

    const charsTyped = fileStats.charsTyped;

    // Get the reconstructed final content length.
    const reconstruction = reconstructFile(index, filePath);
    const finalLength = reconstruction.content.length;

    // If final content is empty, there's nothing to flag.
    if (finalLength === 0) continue;

    let ratio: number;
    let severity: Severity;
    let confidence: number;

    if (charsTyped === 0) {
      // Infinite ratio — user typed nothing but file has content.
      ratio = Infinity;
      severity = 'high';
      // Confidence proportional to final content length.
      confidence = clamp(finalLength / minCharsForConfidence, 0, 1);
    } else {
      ratio = finalLength / charsTyped;

      // Only flag if ratio exceeds the minimum threshold.
      if (ratio < minRatio) continue;

      severity = ratio >= highRatio ? 'high' : 'medium';

      // Confidence: linearly interpolated from charsTyped.
      confidence = clamp(charsTyped / minCharsForConfidence, 0, 1);
    }

    // Collect the seq keys for the doc.save events on this file (best
    // supporting evidence for the ratio — shows what the final content is).
    const saveEvents = (index.byFile.get(filePath) ?? []).filter((e) => e.kind === 'doc.save');
    const supportingSeqs =
      saveEvents.length > 0 ? saveEvents.map((e) => `${e.sessionId}:${e.seq}`) : [];

    const id = flagId(filePath, flagIndex++);
    const ratioStr = isFinite(ratio) ? ratio.toFixed(2) : '∞';

    flags.push({
      id,
      heuristic: 'low_typing_high_output',
      title: `Low typing, high output in ${filePath}`,
      severity,
      confidence,
      supportingSeqs,
      description:
        `Output-to-typing ratio of ${ratioStr}× in ${filePath}: ` +
        `${finalLength} chars in final file vs ${charsTyped} chars typed.`,
      detail: {
        filePath,
        charsTyped,
        finalLength,
        ratio: isFinite(ratio) ? ratio : null,
        tainted: false,
      },
    });
  }

  return flags;
}

export const lowTypingHighOutputHeuristic: Heuristic = {
  id: 'low_typing_high_output',
  label: 'Low typing relative to final output',
  run,
};
