/**
 * Performance bench: bundle load + parse + index (PRD §7.3).
 *
 * Goal: prove the 5s budget for a synthetic ~50 MB bundle (100k events
 * across 5 sessions, chain valid). Pipeline measured: loadBundle → buildIndex.
 *
 * Synthetic event mix (realistic):
 *   80% doc.change (1–3 char deltas, spread across a bounded file)
 *    5% paste (small inline pastes)
 *    5% doc.save
 *   10% other (session.heartbeat, terminal.command, doc.open, etc.)
 *
 * Reconstruction complexity: O(N × avg_line_len) because reconstructFile calls
 * content.split('\n') per delta; multi-line content would be O(N × total_chars).
 * The bench's single-line content keeps line_len small enough to be acceptable.
 * This is a known v2 watch item.
 *
 * Strategy:
 *   - Build the synthetic bundle ONCE in beforeAll and reuse the same ZIP
 *     bytes across all timing iterations (re-building inside each iteration
 *     would dominate the timing and is not what we want to measure).
 *   - Run 5 iterations of load+index, sort timings, print p50/p95/p99.
 *   - Assert the slowest single run is under the budget — that's the user-
 *     observable worst case, not the median.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadBundle } from '../../src/loader/parse-bundle.js';
import { buildIndex } from '../../src/index/build-index.js';
import type { BuiltBundle } from '../helpers/build-test-bundle.js';
import { buildTestBundle } from '../helpers/build-test-bundle.js';
import type { EventSpec } from '../helpers/build-test-bundle.js';

const SESSION_COUNT = 5;
const EVENTS_PER_SESSION = 20_000; // 5 × 20k = 100k events total
const ITERATIONS = 5;
const BUDGET_MS = 5_000;

/**
 * Generate a realistic mix of events for one session.
 *
 * Realistic mix keeps reconstruction acceptable: reconstruction is O(N × avg_line_len),
 * and the single-line content in this bench keeps line_len bounded:
 *   - doc.change events insert 1–3 chars at the end of line 0, so the file
 *     grows slowly to ~40 KB.
 *   - doc.save every ~200 events (matches real save cadence).
 *   - paste every ~20 events (small inline paste, 10–30 chars).
 *   - session.heartbeat, terminal.command sprinkled in.
 *
 * File path is per-session so index.byFile has one key per session (realistic:
 * each student edits one assignment file per session).
 */
function makeEventSpecs(sessionIndex: number, count: number): EventSpec[] {
  const out: EventSpec[] = [];
  const filePath = `/assign/s${sessionIndex}/hw.py`;
  // Track current line-0 length to append at end (keeps content bounded).
  // Grows by ~2 chars per doc.change on average — stays under 40 KB at 20k events.
  let lineLen = 0;

  for (let i = 0; i < count; i++) {
    const seq = i + 1;
    const t = seq * 10; // 10ms between events

    const roll = i % 20; // deterministic cycle of 20 to create a mix

    if (roll === 0) {
      // doc.save (every 20th event = 5% of events)
      out.push({
        kind: 'doc.save',
        data: { path: filePath, sha256: 'a'.repeat(64) },
        t,
      });
    } else if (roll === 1) {
      // paste (small inline, every 20th cycle = 5%)
      const text = `paste${i % 100}`;
      out.push({
        kind: 'paste',
        data: {
          path: filePath,
          range: {
            start: { line: 0, character: lineLen },
            end: { line: 0, character: lineLen },
          },
          content: text,
          length: text.length,
          sha256: 'b'.repeat(64),
          source: 'clipboard',
        },
        t,
      });
      lineLen += text.length;
    } else if (roll === 2) {
      // session.heartbeat (5%)
      out.push({
        kind: 'session.heartbeat',
        data: { files_open: [filePath] },
        t,
      });
    } else if (roll === 3) {
      // terminal.command (5%)
      out.push({
        kind: 'terminal.command',
        data: {
          terminal_id: `t-${sessionIndex}`,
          command: `python hw.py`,
          exit_code: 0,
        },
        t,
      });
    } else {
      // doc.change — ~80% of events (rolls 4–19)
      // Append 2 chars at the end of line 0 to keep content bounded.
      const text = String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + ((i + 1) % 26));
      out.push({
        kind: 'doc.change',
        data: {
          path: filePath,
          deltas: [
            {
              range: {
                start: { line: 0, character: lineLen },
                end: { line: 0, character: lineLen },
              },
              text,
            },
          ],
          source: 'typed' as const,
        },
        t,
      });
      lineLen += text.length;
    }
  }

  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe('bench: load + parse + index', () => {
  let built: BuiltBundle;

  beforeAll(async () => {
    const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
      events: makeEventSpecs(i, EVENTS_PER_SESSION),
    }));
    built = await buildTestBundle({ sessions });
    // Sanity: log size so a regression in the helper is obvious.
    const sizeMB = built.zipBuffer.byteLength / (1024 * 1024);
    console.log(
      `[bench-load] synthetic bundle: ${sizeMB.toFixed(1)} MB, ` +
        `${SESSION_COUNT} sessions × ${EVENTS_PER_SESSION} events = ` +
        `${SESSION_COUNT * EVENTS_PER_SESSION} events`,
    );
  }, /* timeout */ 120_000);

  it(`loads + indexes within ${BUDGET_MS}ms over ${ITERATIONS} runs`, async () => {
    const timings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const result = await loadBundle(built.zipBuffer, 'bench.zip');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('loadBundle failed in bench');
      const index = buildIndex(result.value);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      // Light sanity: index covers all events from all sessions.
      const expectedEventCount = SESSION_COUNT * (EVENTS_PER_SESSION + 1); // +1 for session.start
      expect(index.ordered.length).toBe(expectedEventCount);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1]!;

    console.log(
      `[bench-load] iterations=${ITERATIONS} ` +
        `p50=${p50.toFixed(0)}ms ` +
        `p95=${p95.toFixed(0)}ms ` +
        `p99=${p99.toFixed(0)}ms ` +
        `max=${max.toFixed(0)}ms ` +
        `budget=${BUDGET_MS}ms`,
    );

    // Assert the worst single observed run is under budget — what the user sees.
    expect(max).toBeLessThan(BUDGET_MS);
  }, /* timeout */ 120_000);
});
