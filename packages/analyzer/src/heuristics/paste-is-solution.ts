/**
 * paste_is_solution heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "Paste payload matches ≥80% of the file's final
 * state." Uses Phase 12's reconstructFileWithProvenance to obtain the final
 * file content, then runs diffLines() to compute line overlap between the
 * paste payload and the final content.
 *
 * Fires one Flag per qualifying paste event. Severity is 'high'; confidence
 * is 0.85 (high signal but paste contents could match a skeleton/boilerplate).
 *
 * Threshold: ≥80% of the paste's lines are present in the final file.
 * Specifically: shared_lines / paste_lines ≥ pasteIsSolutionLineOverlap.
 *
 * Only paste events with an inline `content` field are eligible — large pastes
 * (> 4 KB, content omitted) cannot be checked this way. The line overlap
 * metric counts lines that appear on BOTH sides of the diff (i.e., lines that
 * diffLines reports as unchanged).
 */

import { diffLines } from 'diff';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { reconstructFileWithProvenance } from '../index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the number of shared lines between two text strings using
 * diffLines(). A line is "shared" if it appears in both strings (i.e.,
 * the diff part has `count` with no added/removed flag).
 */
function sharedLineCount(textA: string, textB: string): number {
  if (textA.length === 0 || textB.length === 0) return 0;
  const parts = diffLines(textA, textB);
  let shared = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      shared += part.count ?? 0;
    }
  }
  return shared;
}

/**
 * Count lines in a string (number of '\n'-separated segments).
 * Empty string → 0 lines (for threshold purposes).
 */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  // A string with N '\n' chars has N+1 lines.
  return text.split('\n').length;
}

function flagId(seqKey: string, idx: number): string {
  return `paste_is_solution-${seqKey}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const threshold = config.pasteIsSolution.lineOverlap;
  const pasteEvents = index.byKind.get('paste') ?? [];

  // Cache the final state per file path to avoid re-running reconstruction.
  const finalStateCache = new Map<string, string>();

  function getFinalContent(filePath: string): string {
    const cached = finalStateCache.get(filePath);
    if (cached !== undefined) return cached;
    const state = reconstructFileWithProvenance(index, filePath);
    finalStateCache.set(filePath, state.content);
    return state.content;
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const e of pasteEvents) {
    const p = e.payload as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null) continue;

    // Only inline-content pastes can be compared.
    const content = typeof p['content'] === 'string' ? (p['content'] as string) : undefined;
    if (content === undefined || content.length === 0) continue;

    const filePath = typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
    if (filePath === undefined) continue;

    const finalContent = getFinalContent(filePath);
    if (finalContent.length === 0) continue;

    const pasteLines = lineCount(content);
    if (pasteLines === 0) continue;

    const shared = sharedLineCount(content, finalContent);
    const ratio = shared / pasteLines;

    if (ratio < threshold) continue;

    const seqKey = `${e.sessionId}:${e.seq}`;
    const id = flagId(seqKey, flagIndex++);

    flags.push({
      id,
      heuristic: 'paste_is_solution',
      title: `Paste matches solution in ${filePath}`,
      severity: 'high',
      confidence: 0.85,
      supportingSeqs: [seqKey],
      description:
        `A paste in ${filePath} shares ${Math.round(ratio * 100)}% of its lines with the ` +
        `file's final content, suggesting the paste may be the complete solution.`,
      detail: {
        filePath,
        pasteLines,
        sharedLines: shared,
        overlapRatio: ratio,
        threshold,
      },
    });
  }

  return flags;
}

export const pasteIsSolutionHeuristic: Heuristic = {
  id: 'paste_is_solution',
  label: 'Paste matches solution',
  run,
};
