# Operational notifications

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation
**Scope:** `packages/server` only.

## Motivation

Provenance is moving to a single-host deployment (EECS apphost) that protects
academic-integrity evidence. When something important happens — a crash, a dead-lettered
ingest job, the storage volume nearing its hard 1TB quota — the operator (Aaryan) needs to
be _pushed_ a message, not have to notice it in logs. There is no paid SMTP yet, and the
apphost has no external alerting infrastructure we control.

This feature adds a small **operational-notification subsystem**: a `notify()` façade that
always logs and additionally fans out to configurable sinks (a free Discord/Slack-style
incoming webhook now; SMTP later when funded, with zero code change), fed by a curated set
of critical events. It is the mechanism that the deployment's quota monitor, crash alerts,
and lifecycle pings sit on top of, so it ships first.

## Non-goals

- Not a metrics system (Prometheus already exists; a quota gauge is added in the deployment
  feature). This is discrete event push, not time series.
- Not per-request error reporting. Individual 5xx / OAuth `hd` rejections / superadmin
  logins are deliberately **not** notified (too noisy); they roll up into crash and
  job-failure signals.
- No new heavyweight dependency. The webhook sink is a `fetch` POST; the SMTP sink reuses
  the existing `email/transport.ts`.

## Architecture

### The `notify` façade

```ts
type Severity = 'info' | 'warn' | 'critical';

interface NotifyEvent {
  severity: Severity;
  kind: string; // stable machine key, e.g. 'app.startup', 'job.dead_letter'
  title: string; // one-line human summary
  detail?: Record<string, unknown>; // structured context (safe to serialize)
  dedupeKey?: string; // defaults to `kind`; collapses repeats within the window
}

interface Notifier {
  notify(event: NotifyEvent): void; // fire-and-forget; never throws, never blocks
  flush(): Promise<void>; // best-effort drain (used on shutdown/crash)
}
```

`notify()` is **fire-and-forget**: it enqueues, returns immediately, and never throws — a
dead webhook or SMTP server must never break a request path or the ingest pipeline. A
module-level singleton (`getNotifier()`) mirrors `getLogger()`/`getConfig()`, with a
`_resetNotifierForTest()`. Construction takes explicit deps (config slice, sinks, injected
clock) so tests never touch `process.env` or the wall clock.

### Sinks

Each sink implements `send(rendered): Promise<void>` and has a **min-severity threshold**;
an event goes to a sink only if `event.severity >= sink.minSeverity`. Fan-out is
concurrent and independent — one sink failing never affects another, and every failure is
caught and logged locally.

- **log sink** — always present, no threshold (logs everything at the mapped pino level:
  info→info, warn→warn, critical→error). This guarantees the event is at least in the
  journal even if every push sink is down/unconfigured.
- **webhook sink** — POSTs a JSON body to `ALERT_WEBHOOK_URL`. Payload uses the Discord
  incoming-webhook shape (`{ content: "<emoji by severity> **[SEVERITY] title**\n detail" }`),
  which Slack-compatible webhooks also accept. `AbortController` timeout
  (`ALERT_WEBHOOK_TIMEOUT_MS`, default 5000). Absent URL → sink disabled. `fetch` is
  injectable for tests (default: global `fetch`).
- **smtp sink** — reuses the existing `email/transport.ts`. Enabled only when the SMTP
  transport is configured **and** `ALERT_EMAIL_RECIPIENTS` is non-empty. Off by default
  (no funded SMTP yet); lights up with config alone, no code change.

### Throttling / dedup

Repeated events (a crash loop, a wedged job retrying) must not spam the webhook or trip its
rate limit. Per `dedupeKey`, the notifier keeps the last-sent timestamp and a suppressed
counter (injected clock). Within `ALERT_DEDUPE_WINDOW_SECONDS` (default 300) of a send,
further same-key events are suppressed and counted, not sent. The first event after the
window elapses is sent and carries the suppressed count in its detail
(`suppressed_since_last: N`). The log sink is exempt (it logs every occurrence). State is a
bounded in-memory `Map` (LRU-capped so an unbounded key space can't leak).

### Crash & lifecycle wiring

- `index.ts` installs `process.on('uncaughtException')` and `'unhandledRejection'`
  handlers that `notify({severity:'critical', kind:'process.crash', ...})`, `await
notifier.flush()` with a hard timeout, then exit non-zero. These augment (do not replace)
  the existing `.catch` path.
- `index.ts` emits `app.startup` (info: git SHA via `GIT_SHA` env baked at build, run mode,
  blob backend, which crons armed) after a successful boot, and `app.shutdown` (info:
  signal) inside the existing SIGTERM/SIGINT `shutdown()` before draining.
- `worker.ts` hooks pg-boss's existing `boss.on('error')` → `notify({critical,
kind:'pgboss.error'})`.

### Job-failure notifications

A `withFailureNotification(kind, handler)` wrapper decorates pg-boss job handlers: on a
thrown error it inspects the job's `retryCount` vs `retryLimit` and notifies **only when
retries are exhausted** (severity: the job's configured level — `warn` for recompute/cross-
flags/sweeps, `warn` for a dead-lettered ingest file), then **rethrows** so pg-boss still
records the failure and its own retry/dead-letter logic is unchanged. This avoids notifying
on every transient retry.

## Config (env additions)

| Var                           | Default    | Meaning                                                               |
| ----------------------------- | ---------- | --------------------------------------------------------------------- |
| `ALERT_WEBHOOK_URL`           | (unset)    | Discord/Slack incoming webhook; unset → webhook sink off              |
| `ALERT_WEBHOOK_MIN_SEVERITY`  | `warn`     | Min severity for the webhook sink                                     |
| `ALERT_WEBHOOK_TIMEOUT_MS`    | `5000`     | Per-POST timeout                                                      |
| `ALERT_EMAIL_RECIPIENTS`      | `[]`       | JSON array; empty → smtp sink off                                     |
| `ALERT_SMTP_MIN_SEVERITY`     | `critical` | Min severity for the smtp sink                                        |
| `ALERT_DEDUPE_WINDOW_SECONDS` | `300`      | Per-key suppression window                                            |
| `GIT_SHA`                     | (unset)    | Build commit, surfaced in the startup event (baked by the Dockerfile) |

Existing `SMTP_URL`/`SMTP_FROM` are reused by the smtp sink.

## Event catalog (v1)

| Severity | kind              | Trigger                                              |
| -------- | ----------------- | ---------------------------------------------------- |
| critical | `process.crash`   | uncaughtException / unhandledRejection (before exit) |
| critical | `pgboss.error`    | pg-boss `error` event                                |
| warn     | `job.dead_letter` | a pg-boss job handler throws with retries exhausted  |
| info     | `app.startup`     | successful boot (sha, mode, backend, crons)          |
| info     | `app.shutdown`    | SIGTERM/SIGINT graceful shutdown                     |

The **quota** (`storage.quota_*`) and **blob-write-failure** (`storage.write_failed`) events
listed in the operator catalogue are emitted by the _deployment_ feature's quota-check cron
and blob path, which call this `notify()`. They are documented here for completeness but
implemented there.

## Testing

- Sink fan-out: an event at severity S reaches exactly the sinks whose threshold ≤ S; a
  throwing sink doesn't stop the others; all sinks get the same rendered content.
- Webhook sink: injected `fetch` captures the POSTed Discord-shaped body; timeout path
  (aborted fetch) is swallowed and logged, `notify` still returns.
- smtp sink: off when recipients empty / transport unconfigured; on otherwise (transport
  mocked).
- Throttling: injected clock — 2nd same-key event within the window is suppressed and
  counted; first event after the window carries `suppressed_since_last`; different keys are
  independent; the LRU cap bounds the key map.
- Crash handlers: a unit-testable `handleFatal(err)` (separate from the `process.on`
  registration) notifies critical and flushes.
- Job-failure wrapper: throw with `retryCount < retryLimit` → no notify; throw with retries
  exhausted → one notify; the error is always rethrown.
- `notify()` never throws even if every sink throws synchronously.

## Deployment note

`ALERT_WEBHOOK_URL` will point at a free Discord incoming webhook initially. When campus
SMTP (or funded SMTP) is available, set `ALERT_EMAIL_RECIPIENTS` (and `SMTP_URL`/`SMTP_FROM`)
and the smtp sink activates with no code change. See `docs/deploy-apphost.md`.
