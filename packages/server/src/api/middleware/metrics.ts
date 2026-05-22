/**
 * Prometheus-format metrics middleware and exposition endpoint.
 *
 * ## Dependency decision (V37)
 *
 * `prom-client` is NOT in deps. Before adding a new dependency (per CLAUDE.md),
 * we use a minimal hand-rolled approach:
 *
 *   - A `Map<string, number>` of counters (label → count).
 *   - A sampled histogram stored as `Map<string, number[]>` (label → duration samples).
 *   - Exposition writes Prometheus text format (counter lines + histogram summary).
 *
 * Trade-off vs prom-client:
 *   PRO: zero new deps; simple to understand; matches our scale.
 *   CON: no OpenMetrics support; no native histogram buckets; no registry reset
 *        between tests without our own hook; no cluster-mode aggregation (irrelevant
 *        for a single-process server).
 *
 * If prom-client is added in a future phase, the metrics module can be swapped
 * without changing the exposition endpoint.
 *
 * ## /metrics auth (V37)
 *
 * The plan §671 says: "/metrics on a separate listener (not public)".
 * For simplicity, we mount it on the same Hono app at `/metrics` and protect
 * it with a `METRICS_AUTH_TOKEN` env variable check (header `Authorization: Bearer <token>`).
 *
 * Trade-off vs separate listener:
 *   PRO: no second TCP port to manage; no separate process / systemd unit.
 *   CON: /metrics is technically reachable from the public port (though gated by auth).
 *
 * When deploying behind a reverse proxy, the proxy can block `/metrics` at
 * the ingress layer. The env-token auth is a defense-in-depth fallback.
 *
 * If METRICS_AUTH_TOKEN is not set, /metrics returns 403 in all environments
 * (fail-closed — better than an open metrics endpoint).
 */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Internal metric stores
// ---------------------------------------------------------------------------

/** Counter: label → count */
const _counters = new Map<string, number>();

/** Histogram samples: label → last N duration values in ms */
const HISTOGRAM_WINDOW = 1000; // keep last 1000 samples per label
const _histograms = new Map<string, number[]>();

/** @internal — exposed for test reset between test runs. */
export function _resetMetricsForTest(): void {
  _counters.clear();
  _histograms.clear();
}

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

function incrementCounter(name: string, labels: Record<string, string>): void {
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',');
  const key = `${name}{${labelStr}}`;
  _counters.set(key, (_counters.get(key) ?? 0) + 1);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// Histogram helpers
// ---------------------------------------------------------------------------

function recordHistogram(name: string, labels: Record<string, string>, valueMs: number): void {
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',');
  const key = `${name}{${labelStr}}`;
  const samples = _histograms.get(key) ?? [];
  samples.push(valueMs);
  if (samples.length > HISTOGRAM_WINDOW) {
    samples.splice(0, samples.length - HISTOGRAM_WINDOW);
  }
  _histograms.set(key, samples);
}

// ---------------------------------------------------------------------------
// Public increment APIs (called from outside this module)
// ---------------------------------------------------------------------------

/**
 * Increment provenance_ingest_jobs_total for a terminal job status.
 * Called from the ingest worker when a job reaches terminal status.
 */
export function recordIngestJobTerminal(status: string): void {
  incrementCounter('provenance_ingest_jobs_total', { status });
}

/**
 * Increment provenance_recompute_jobs_total for a terminal recompute status.
 * Called from the recompute finalize handler.
 */
export function recordRecomputeJobTerminal(status: string): void {
  incrementCounter('provenance_recompute_jobs_total', { status });
}

// ---------------------------------------------------------------------------
// Request metrics middleware
// ---------------------------------------------------------------------------

/**
 * Wraps every request to record:
 *   - provenance_requests_total{method, route, status}
 *   - provenance_request_duration_ms{route} histogram sample
 *
 * Route is normalized to the matched path pattern (e.g. /submissions/:submissionId)
 * to prevent label cardinality explosion from UUIDs in paths.
 */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const startMs = Date.now();
  await next();
  const durationMs = Date.now() - startMs;

  const method = c.req.method.toUpperCase();
  // Use the matched route pattern if available (avoids UUID cardinality explosion).
  // Hono exposes the matched route as c.req.routePath (or falls back to path).
  // The `routePath` property is available on HonoRequest in Hono ≥4.
  const route: string = (c.req as unknown as { routePath?: string }).routePath ?? c.req.path;
  const status = String(c.res.status);

  incrementCounter('provenance_requests_total', { method, route, status });
  recordHistogram('provenance_request_duration_ms', { route }, durationMs);
};

// ---------------------------------------------------------------------------
// Prometheus text format exposition
// ---------------------------------------------------------------------------

/**
 * Renders all metrics as Prometheus text format (text/plain; version=0.0.4).
 *
 * Includes:
 *   - All counters.
 *   - Histogram summary: sum, count, p50, p95, p99 per label.
 */
function renderMetrics(): string {
  const lines: string[] = [];

  // --- Counters ---
  lines.push('# HELP provenance_requests_total Total HTTP requests');
  lines.push('# TYPE provenance_requests_total counter');
  for (const [key, value] of _counters) {
    if (key.startsWith('provenance_requests_total')) {
      lines.push(`${key} ${value}`);
    }
  }

  lines.push('# HELP provenance_ingest_jobs_total Ingest jobs reaching terminal status');
  lines.push('# TYPE provenance_ingest_jobs_total counter');
  for (const [key, value] of _counters) {
    if (key.startsWith('provenance_ingest_jobs_total')) {
      lines.push(`${key} ${value}`);
    }
  }

  lines.push('# HELP provenance_recompute_jobs_total Recompute jobs reaching terminal status');
  lines.push('# TYPE provenance_recompute_jobs_total counter');
  for (const [key, value] of _counters) {
    if (key.startsWith('provenance_recompute_jobs_total')) {
      lines.push(`${key} ${value}`);
    }
  }

  // --- Histograms (as summary with quantiles) ---
  lines.push('# HELP provenance_request_duration_ms Request duration in milliseconds');
  lines.push('# TYPE provenance_request_duration_ms summary');
  for (const [key, samples] of _histograms) {
    if (!key.startsWith('provenance_request_duration_ms')) continue;
    if (samples.length === 0) continue;

    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const p = (q: number): number => sorted[Math.floor(q * (n - 1))] ?? 0;

    // Extract label part (everything between { })
    const labelMatch = /\{(.+)\}/.exec(key);
    const labelPart = labelMatch?.[1] ?? '';

    lines.push(`provenance_request_duration_ms{${labelPart},quantile="0.5"} ${p(0.5)}`);
    lines.push(`provenance_request_duration_ms{${labelPart},quantile="0.95"} ${p(0.95)}`);
    lines.push(`provenance_request_duration_ms{${labelPart},quantile="0.99"} ${p(0.99)}`);
    lines.push(`provenance_request_duration_ms_sum{${labelPart}} ${sum}`);
    lines.push(`provenance_request_duration_ms_count{${labelPart}} ${n}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// /metrics router factory
// ---------------------------------------------------------------------------

/**
 * Mounts GET /metrics behind METRICS_AUTH_TOKEN header check.
 *
 * If METRICS_AUTH_TOKEN is not set in env, returns 403 for all requests
 * (fail-closed — don't expose metrics without an auth token configured).
 *
 * Mount at the top-level app (NOT under /api/v1) so it remains separate
 * from the versioned API surface.
 */
export function createMetricsRouter(): Hono {
  const router = new Hono();

  router.get('/metrics', (c) => {
    const expectedToken = process.env['METRICS_AUTH_TOKEN'] ?? '';
    if (expectedToken === '') {
      // No token configured — fail closed.
      return c.text('Metrics endpoint requires METRICS_AUTH_TOKEN to be configured.', 403);
    }

    const authHeader = c.req.header('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(authHeader);
    const providedToken = match?.[1] ?? '';

    // Constant-time comparison to prevent timing attacks.
    // The token is short so we pad both to the same length.
    const expected = Buffer.from(expectedToken, 'utf-8');
    const provided = Buffer.from(providedToken, 'utf-8');
    const maxLen = Math.max(expected.length, provided.length);
    const padded1 = Buffer.concat([expected, Buffer.alloc(maxLen - expected.length)]);
    const padded2 = Buffer.concat([provided, Buffer.alloc(maxLen - provided.length)]);

    let mismatch = padded1.length !== padded2.length ? 1 : 0;
    for (let i = 0; i < padded1.length; i++) {
      mismatch |= padded1[i]! ^ padded2[i]!;
    }

    if (mismatch !== 0) {
      return c.text('Unauthorized', 401);
    }

    const body = renderMetrics();
    c.header('Content-Type', 'text/plain; version=0.0.4');
    return c.body(body);
  });

  return router;
}
