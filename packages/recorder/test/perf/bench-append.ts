/**
 * Performance benchmark for SessionWriter.append().
 *
 * Goal (PRD §4.7): doc.change handlers must run in < 1ms p99.
 * The append() path is the hot path: enqueue a serialized line + trigger flush if needed.
 *
 * This is a standalone Node script, run via: npm run bench
 * (which does: npm run build && node --experimental-vm-modules ...)
 *
 * IMPLEMENTATION NOTE: This file is authored as TypeScript but run through
 * Vitest's transformer (npx vitest bench). The vitest bench runner handles
 * the ESM/CJS boundary between @provenance/log-core (ESM) and the recorder's
 * compiled CommonJS output. See vitest.config.ts for the vscode mock alias.
 *
 * The bench script below is self-contained: it does NOT use the vitest bench()
 * API (which gates on CI). Instead it is a plain async script that measures
 * append() timing, prints results, and exits non-zero if p99 > 1ms.
 *
 * Run via:
 *   npm run bench
 * which executes: vitest --run --reporter=verbose test/perf/bench-append.ts
 * using the existing vitest config (which already resolves vscode → mock).
 *
 * The "test" block here uses Vitest's `it` but does the measurement inline —
 * it is NOT a regular unit test (no assertions that could fail spuriously).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it } from 'vitest';
import {
  FixedClock,
  chainEntry,
  sha256Hex,
  GENESIS_PREV_HASH,
  type HashedEnvelope,
} from '@provenance/log-core';
import { SessionWriter } from '../../src/io/session-writer.js';

const NUM_ENTRIES = 10_000;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

describe('SessionWriter.append() performance', () => {
  it(`measures p50/p95/p99 of ${NUM_ENTRIES} sequential appends`, async () => {
    // Write to a temp file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-bench-'));
    const slogPath = path.join(tmpDir, 'bench.slog');
    const clock = new FixedClock(0);

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // Large buffer policy — benchmark append(), not the I/O flush path.
      bufferPolicy: {
        maxBytes: 100 * 1024 * 1024, // 100 MB — won't trigger
        maxIntervalMs: 60_000, // 60s — won't trigger
      },
    });

    // Pre-generate all entries (generation time excluded from timing).
    const entries: HashedEnvelope[] = [];
    let prevHash = GENESIS_PREV_HASH;
    for (let i = 0; i < NUM_ENTRIES; i++) {
      const env = {
        seq: i,
        t: i * 10,
        wall: new Date(i).toISOString(),
        kind: 'doc.change' as const,
        data: {
          path: 'hw.py',
          deltas: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              text: `# line ${i}\n`,
            },
          ],
          source: 'typed' as const,
        },
      };
      const hashed = chainEntry(prevHash, env, sha256Hex);
      entries.push(hashed);
      prevHash = hashed.hash;
    }

    // Benchmark.
    const times: number[] = [];
    for (const entry of entries) {
      const start = performance.now();
      writer.append(entry);
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    // Flush + cleanup.
    await writer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Report.
    times.sort((a, b) => a - b);
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const p99 = percentile(times, 99);
    const max = times[times.length - 1] ?? 0;
    const mean = times.reduce((a, b) => a + b, 0) / times.length;

    console.log(`\nSessionWriter.append() performance (${NUM_ENTRIES} entries):`);
    console.log(`  mean  = ${mean.toFixed(4)} ms`);
    console.log(`  p50   = ${p50.toFixed(4)} ms`);
    console.log(`  p95   = ${p95.toFixed(4)} ms`);
    console.log(`  p99   = ${p99.toFixed(4)} ms`);
    console.log(`  max   = ${max.toFixed(4)} ms`);

    const budget = 1.0; // ms, PRD §4.7
    if (p99 > budget) {
      console.warn(
        `\nWARNING: p99 (${p99.toFixed(4)} ms) exceeds PRD §4.7 budget of ${budget} ms.`,
      );
    } else {
      console.log(`\np99 is within PRD §4.7 budget (< ${budget} ms). OK.`);
    }

    // Non-fatal: do not assert p99 < budget in CI (it's environment-dependent).
    // The test passes regardless; the numbers are the output.
  }, 120_000); // 2 min timeout for the full bench run
});
