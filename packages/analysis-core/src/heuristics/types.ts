/**
 * Core types for the v1 heuristics engine (Phase 4).
 *
 * PRD §7.4 — heuristic shape: name, severity, confidence, supporting seqs,
 * jump-to link.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'low' | 'medium' | 'high';

/**
 * A single heuristic finding.
 *
 * `id` — unique per flag (not per heuristic). Deterministic across runs:
 *   `${heuristicId}-${supportingSeqs[0] ?? 'no-seq'}-${indexWithinHeuristic}`
 *   Never uses Math.random() or Date.now().
 *
 * `heuristic` — matches the name column in PRD §7.4 table (e.g. `large_paste`).
 *
 * `supportingSeqs` — `${sessionId}:${seq}` keys that match EventIndex.bySeq.
 *   UI components in Phase 6/7 use these to deep-link into the timeline.
 *
 * `confidence` — 0..1 float; see config.ts for the rubric.
 *
 * `detail` — heuristic-specific structured data (ratios, counts, etc.).
 */
export type Flag = {
  id: string;
  heuristic: string;
  title: string;
  severity: Severity;
  confidence: number; // 0..1
  supportingSeqs: string[]; // `${sessionId}:${seq}` keys
  description: string;
  detail?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Heuristic
// ---------------------------------------------------------------------------

/**
 * A single registered heuristic.
 *
 * `run` is a pure synchronous function — no async, no I/O, no side effects.
 * The orchestrator (run-heuristics.ts) calls each one in a fixed registry order
 * and merges the result lists.
 */
export type Heuristic = {
  id: string;
  label: string;
  run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[];
};
