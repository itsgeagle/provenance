/**
 * Lightweight, opt-in ingest profiler — DEV/DIAGNOSTIC ONLY.
 *
 * Gated behind the `INGEST_PROFILE=1` env var. When disabled (the default, and
 * always in production) every entry point is a branch-and-return no-op, so this
 * module imposes no measurable cost on the ingest hot path.
 *
 * When enabled it accumulates per-phase wall-clock time across the bundles of a
 * batch into process-local counters. The `scripts/profile-ingest.ts` harness
 * (and `npm run seed`) dump the table once the batch settles to show where the
 * time went.
 *
 * Concurrency caveat: the worker now processes up to INGEST_CONCURRENCY files at
 * once (pg-boss batch). When concurrency > 1 the per-phase spans of different
 * bundles OVERLAP, so the summed table OVER-COUNTS relative to wall-clock — read
 * it as a relative-cost shape, and trust the harness's separately-measured
 * wall-clock drain for throughput. For a single bundle (`profile:large`, one
 * job) there is no overlap and the table is exact.
 *
 * This is intentionally NOT wired into Prometheus: it answers "where does a
 * 700-bundle import spend its time", a one-off profiling question, not an
 * ongoing operational metric.
 */

export const ingestProfileEnabled = process.env['INGEST_PROFILE'] === '1';

type PhaseStat = { totalMs: number; count: number; maxMs: number };

const stats = new Map<string, PhaseStat>();

function add(name: string, durMs: number): void {
  const s = stats.get(name);
  if (s === undefined) {
    stats.set(name, { totalMs: durMs, count: 1, maxMs: durMs });
    return;
  }
  s.totalMs += durMs;
  s.count += 1;
  if (durMs > s.maxMs) s.maxMs = durMs;
}

/**
 * Time an async phase. When profiling is off this is a direct passthrough with
 * no timing overhead. Records duration even if `fn` throws (the phase still
 * consumed wall time before failing).
 */
export async function timePhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!ingestProfileEnabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    add(name, performance.now() - start);
  }
}

/** Record a pre-measured duration (for phases that already track their own span). */
export function recordPhase(name: string, durMs: number): void {
  if (!ingestProfileEnabled) return;
  add(name, durMs);
}

export type ProfileRow = { name: string; totalMs: number; count: number; maxMs: number };

/** Snapshot the accumulated phases, sorted by total time descending. */
export function getProfileSnapshot(): ProfileRow[] {
  return [...stats.entries()]
    .map(([name, s]) => ({ name, totalMs: s.totalMs, count: s.count, maxMs: s.maxMs }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Reset all counters (useful when a single process runs more than one batch). */
export function resetProfile(): void {
  stats.clear();
}

/**
 * Render the accumulated table via the supplied log sink. The percentage column
 * is each phase's share of the summed per-phase time (NOT wall clock — phases
 * nest and overlap, e.g. the inner tx phases sum into create_submission's
 * sibling, so percentages are a relative-cost guide, not a wall-clock split).
 */
export function dumpProfile(logLine: (msg: string) => void): void {
  if (!ingestProfileEnabled) return;
  const rows = getProfileSnapshot();
  if (rows.length === 0) {
    logLine('ingest-profile: no phases recorded');
    return;
  }
  const grand = rows.reduce((acc, r) => acc + r.totalMs, 0);
  logLine('─── ingest profile (summed per-phase wall time across bundles) ───');
  logLine(
    `${'phase'.padEnd(22)} ${'total'.padStart(10)} ${'n'.padStart(6)} ` +
      `${'avg'.padStart(9)} ${'max'.padStart(9)}   share`,
  );
  for (const r of rows) {
    const pct = grand > 0 ? (r.totalMs / grand) * 100 : 0;
    logLine(
      `${r.name.padEnd(22)} ${fmtS(r.totalMs).padStart(10)} ${String(r.count).padStart(6)} ` +
        `${fmtMs(r.totalMs / r.count).padStart(9)} ${fmtMs(r.maxMs).padStart(9)}   ${pct.toFixed(1)}%`,
    );
  }
  logLine('─'.repeat(70));
}

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}
