/**
 * Performance benchmark for the inline-content emit path.
 *
 * Context: MAX_INLINE_BYTES was raised from 4 KB to 64 KB so that genuine
 * external writes and large pastes stay recoverable (PRD §4.3 / §4.5). That
 * makes individual event payloads up to 16x larger, and every payload goes
 * through JCS canonicalization + SHA-256 + ndjson serialization on the
 * recorder's synchronous emit path.
 *
 * THIS IS A CHARACTERISATION, NOT A BUDGET GATE. PRD §4.7's CPU constraint is
 * scoped to `doc.change` handlers — the one-event-per-keystroke firehose — and
 * `paste` / `fs.external_change` are not covered by it. bench-append.ts is what
 * measures the constraint that actually exists (p99 ~0.007 ms, comfortably met).
 * Nothing here is a §4.7 violation; these numbers exist so a future regression
 * in the large-payload path is visible rather than silent.
 *
 * It measures the whole synchronous cost of emitting one content-carrying event
 * at 4 / 16 / 64 KB:
 *
 *   1. buildPastePayload / buildExternalChangeContent  (byte length + sha256)
 *   2. chainEntry                                      (JCS canonicalize + sha256)
 *   3. SessionWriter.append                            (serialize + enqueue)
 *
 * READING THE NUMBERS. Cost scales roughly linearly with payload size: at 64 KB
 * expect p50 and p95 around 0.6 ms. p99 runs noticeably higher (~1.0-1.4 ms)
 * because roughly 1% of samples pay a garbage collection on the large-string
 * allocation — the path is not slow, it has a GC tail. These events are also
 * RARE: a `paste` fires when a student pastes, and post-D1-fix an
 * `fs.external_change` fires only on a genuine external write, so a realistic
 * session emits a handful, not thousands.
 *
 * Run via: npm run bench   (vitest.bench.config.ts includes test/perf/**)
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
import { buildPastePayload } from '../../src/events/paste-payload.js';
import { buildExternalChangeContent } from '../../src/events/external-change-content.js';

const ITERATIONS = 500;

/**
 * Reporting threshold only — NOT a PRD §4.7 budget (that one is scoped to
 * doc.change handlers, which this bench does not exercise). Sizes above this get
 * called out in the output so a regression is visible; nothing here fails a build.
 */
const REPORT_ABOVE_MS = 1.0;

/** Payload sizes to measure, in bytes. 64 KB is the new cap. */
const SIZES = [4 * 1024, 16 * 1024, 64 * 1024];

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function summarize(label: string, times: number[]): number {
  times.sort((a, b) => a - b);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const p99 = percentile(times, 99);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `  ${label.padEnd(34)} mean=${mean.toFixed(4)}  p50=${p50.toFixed(4)}  ` +
      `p95=${p95.toFixed(4)}  p99=${p99.toFixed(4)} ms`,
  );
  return p99;
}

/**
 * Realistic source-like text of approximately `bytes` UTF-8 bytes. ASCII, so
 * byte length == char length; line structure roughly matches real source so
 * the JSON string escaping cost (newlines) is representative.
 */
function sourceLikeText(bytes: number): string {
  const line = '    result = compute(value, index)  # a representative line\n'; // 59 bytes
  const repeats = Math.ceil(bytes / line.length);
  return line.repeat(repeats).slice(0, bytes);
}

describe('inline-content emit path performance', () => {
  it(`measures paste + fs.external_change emit cost at ${SIZES.map((s) => s / 1024).join('/')} KB`, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-bench-inline-'));
    const slogPath = path.join(tmpDir, 'bench.slog');
    const clock = new FixedClock(0);

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // Large buffer policy — measure the emit path, not the I/O flush path.
      bufferPolicy: { maxBytes: 512 * 1024 * 1024, maxIntervalMs: 600_000 },
    });

    const worst: Array<{ label: string; p99: number }> = [];

    console.log(`\ninline-content emit path (${ITERATIONS} iterations per size):`);

    for (const size of SIZES) {
      const text = sourceLikeText(size);
      const kb = size / 1024;

      // --- paste ---------------------------------------------------------
      {
        const times: number[] = [];
        let prevHash = GENESIS_PREV_HASH;
        for (let i = 0; i < ITERATIONS; i++) {
          const start = performance.now();
          const fields = buildPastePayload(text);
          const env = {
            seq: i,
            t: i * 10,
            wall: new Date(i).toISOString(),
            kind: 'paste' as const,
            data: {
              path: 'hw.py',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              ...fields,
            },
          };
          const hashed: HashedEnvelope = chainEntry(prevHash, env, sha256Hex);
          writer.append(hashed);
          times.push(performance.now() - start);
          prevHash = hashed.hash;
        }
        worst.push({ label: `paste ${kb} KB`, p99: summarize(`paste ${kb} KB`, times) });
      }

      // --- fs.external_change ---------------------------------------------
      {
        const times: number[] = [];
        let prevHash = GENESIS_PREV_HASH;
        for (let i = 0; i < ITERATIONS; i++) {
          const start = performance.now();
          const fields = buildExternalChangeContent(text);
          const env = {
            seq: i,
            t: i * 10,
            wall: new Date(i).toISOString(),
            kind: 'fs.external_change' as const,
            data: {
              path: 'hw.py',
              operation: 'modify' as const,
              old_hash: sha256Hex('previous'),
              new_hash: sha256Hex(text),
              diff_size: 1,
              ...fields,
            },
          };
          const hashed: HashedEnvelope = chainEntry(prevHash, env, sha256Hex);
          writer.append(hashed);
          times.push(performance.now() - start);
          prevHash = hashed.hash;
        }
        worst.push({
          label: `fs.external_change ${kb} KB`,
          p99: summarize(`fs.external_change ${kb} KB`, times),
        });
      }
    }

    await writer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const notable = worst.filter((w) => w.p99 > REPORT_ABOVE_MS);
    if (notable.length > 0) {
      console.log(`\nAbove ${REPORT_ABOVE_MS} ms p99 (expected at 64 KB — GC tail, see header):`);
      for (const b of notable) {
        console.log(`  ${b.label}: p99 = ${b.p99.toFixed(4)} ms`);
      }
    }

    // Non-fatal, matching bench-append.ts: the numbers are the output, and
    // absolute timings are environment-dependent.
  }, 300_000);
});
