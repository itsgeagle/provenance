# Operational Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `notify()` façade in the server that always logs and fans out critical events to configurable sinks (Discord/Slack webhook now, SMTP later), with throttling and a curated event catalog.

**Architecture:** Module-level `getNotifier()` singleton (mirrors `getLogger()`/`getConfig()`). `notify(event)` is fire-and-forget, never throws, never blocks. Sinks (log always; webhook; smtp) each have a min-severity threshold; fan-out is concurrent and failure-isolated. Per-`dedupeKey` throttling with an injected clock suppresses repeats within a window and reports the suppressed count. Crash/lifecycle/pg-boss/job-failure call sites feed it.

**Tech Stack:** TypeScript strict ESM, Zod (env), pino (existing logger), nodemailer via the existing `email/transport.ts`, global `fetch` (injectable). Vitest.

## Global Constraints

- Scope `packages/server/**` only. No new npm dependencies (reuse `nodemailer` via `email/transport.ts`, global `fetch`).
- TypeScript strict; no `any` except at an FFI boundary with a comment; `unknown` + narrowing for untyped input.
- `notify()` MUST never throw and MUST never block the caller (fire-and-forget). A failing/timing-out/absent sink must never propagate.
- No `Date.now()`/`Math.random()` in test assertions — inject the clock. The throttler takes an injected `now()`.
- Every sink failure is caught and logged locally; the log sink always runs regardless of push-sink state.
- Commit after every task: `git commit --no-gpg-sign`, conventional prefix, no `Co-Authored-By` trailer.
- Severity ordering: `info < warn < critical`. A sink with `minSeverity=warn` receives `warn` and `critical`, not `info`.
- Verify from repo root: `npm run typecheck --workspace=packages/server`, `npm run lint --workspace=packages/server`, focused tests `npm run test --workspace=packages/server -- <path>`.

## File Structure

**Create:**

- `packages/server/src/notify/severity.ts` — `Severity`, ordering helper.
- `packages/server/src/notify/types.ts` — `NotifyEvent`, `Sink`, `Notifier` interfaces.
- `packages/server/src/notify/render.ts` — render a `NotifyEvent` to a plain-text + Discord payload.
- `packages/server/src/notify/throttle.ts` — `Throttler` (injected clock, LRU-capped).
- `packages/server/src/notify/sinks/log-sink.ts`, `webhook-sink.ts`, `smtp-sink.ts`.
- `packages/server/src/notify/notifier.ts` — `createNotifier(deps)`, `getNotifier()`, `_resetNotifierForTest()`.
- `packages/server/src/notify/fatal.ts` — `handleFatal(err, notifier)` + `installCrashHandlers(notifier)`.
- `packages/server/src/notify/job-failure.ts` — `withFailureNotification(kind, severity, handler)`.
- Co-located `*.test.ts` for each.

**Modify:**

- `packages/server/src/config/env.ts` — `ALERT_*` vars + `GIT_SHA`.
- `packages/server/src/index.ts` — install crash handlers; emit `app.startup`/`app.shutdown`.
- `packages/server/src/jobs/worker.ts` — `boss.on('error')` → notify; wrap cron handlers with `withFailureNotification`.

---

## Task 1: Config — alert env vars

**Files:** Modify `packages/server/src/config/env.ts`; Test `packages/server/src/config/env.test.ts`.

**Interfaces — Produces (on `Env`):** `ALERT_WEBHOOK_URL?: string`, `ALERT_WEBHOOK_MIN_SEVERITY: 'info'|'warn'|'critical'` (default `warn`), `ALERT_WEBHOOK_TIMEOUT_MS: number` (5000), `ALERT_EMAIL_RECIPIENTS: string[]` (default `[]`, JSON), `ALERT_SMTP_MIN_SEVERITY` (default `critical`), `ALERT_DEDUPE_WINDOW_SECONDS: number` (300), `GIT_SHA?: string`.

- [ ] **Step 1: Failing test** — add to `env.test.ts`:

```ts
describe('alert config', () => {
  it('defaults are applied', () => {
    const env = parseEnv(VALID_BASE);
    expect(env.ALERT_WEBHOOK_MIN_SEVERITY).toBe('warn');
    expect(env.ALERT_WEBHOOK_TIMEOUT_MS).toBe(5000);
    expect(env.ALERT_EMAIL_RECIPIENTS).toEqual([]);
    expect(env.ALERT_SMTP_MIN_SEVERITY).toBe('critical');
    expect(env.ALERT_DEDUPE_WINDOW_SECONDS).toBe(300);
    expect(env.ALERT_WEBHOOK_URL).toBeUndefined();
  });
  it('parses a webhook url + recipients array', () => {
    const env = parseEnv({
      ...VALID_BASE,
      ALERT_WEBHOOK_URL: 'https://discord.test/hook',
      ALERT_EMAIL_RECIPIENTS: '["a@berkeley.edu","b@berkeley.edu"]',
    });
    expect(env.ALERT_WEBHOOK_URL).toBe('https://discord.test/hook');
    expect(env.ALERT_EMAIL_RECIPIENTS).toEqual(['a@berkeley.edu', 'b@berkeley.edu']);
  });
  it('rejects a bad severity', () => {
    expect(() => parseEnv({ ...VALID_BASE, ALERT_WEBHOOK_MIN_SEVERITY: 'loud' })).toThrow();
  });
});
```

- [ ] **Step 2: Verify red** — `npm run test --workspace=packages/server -- src/config/env.test.ts` → FAIL.
- [ ] **Step 3: Implement** — in `rawEnvSchema` add (reuse the existing `intStr` and `jsonStringArray` helpers):

```ts
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_WEBHOOK_MIN_SEVERITY: z.enum(['info', 'warn', 'critical']).default('warn'),
  ALERT_WEBHOOK_TIMEOUT_MS: intStr(5000),
  ALERT_EMAIL_RECIPIENTS: jsonStringArray.default('[]'),
  ALERT_SMTP_MIN_SEVERITY: z.enum(['info', 'warn', 'critical']).default('critical'),
  ALERT_DEDUPE_WINDOW_SECONDS: intStr(300),
  GIT_SHA: z.string().optional(),
```

- [ ] **Step 4: Verify green** — the test passes; typecheck + lint clean.
- [ ] **Step 5: Commit** — `feat(server): alert/notification config env vars`.

---

## Task 2: Notifier core — types, sinks contract, fan-out, log sink

**Files:** Create `notify/severity.ts`, `notify/types.ts`, `notify/render.ts`, `notify/sinks/log-sink.ts`, `notify/notifier.ts`; Tests co-located.

**Interfaces — Produces:**

- `severity.ts`: `type Severity = 'info'|'warn'|'critical'`; `const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, critical: 2 }`; `function meets(evt: Severity, min: Severity): boolean`.
- `types.ts`: `NotifyEvent` (`severity, kind, title, detail?, dedupeKey?`); `interface Sink { name: string; minSeverity: Severity; send(rendered: RenderedEvent): Promise<void> }`; `interface Notifier { notify(e: NotifyEvent): void; flush(): Promise<void> }`.
- `render.ts`: `interface RenderedEvent { severity: Severity; kind: string; title: string; text: string; discordContent: string }`; `function renderEvent(e: NotifyEvent): RenderedEvent`.
- `notifier.ts`: `function createNotifier(deps: { sinks: Sink[]; logger: Logger }): Notifier`; `getNotifier(): Notifier`; `_resetNotifierForTest(): void`.

- [ ] **Step 1: Failing tests** — `notifier.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createNotifier } from './notifier.js';
import type { Sink } from './types.js';
import pino from 'pino';

function fakeSink(
  name: string,
  minSeverity: 'info' | 'warn' | 'critical',
): Sink & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    minSeverity,
    calls,
    send: async (r) => {
      calls.push(r);
    },
  };
}
const logger = pino({ enabled: false });

describe('createNotifier fan-out', () => {
  it('routes an event only to sinks whose threshold is met', async () => {
    const warnSink = fakeSink('w', 'warn');
    const critSink = fakeSink('c', 'critical');
    const n = createNotifier({ sinks: [warnSink, critSink], logger });
    n.notify({ severity: 'warn', kind: 'k', title: 't' });
    await n.flush();
    expect(warnSink.calls).toHaveLength(1);
    expect(critSink.calls).toHaveLength(0);
  });
  it('a throwing sink does not stop the others and does not throw to caller', async () => {
    const bad: Sink = {
      name: 'bad',
      minSeverity: 'info',
      send: async () => {
        throw new Error('x');
      },
    };
    const good = fakeSink('good', 'info');
    const n = createNotifier({ sinks: [bad, good], logger });
    expect(() => n.notify({ severity: 'critical', kind: 'k', title: 't' })).not.toThrow();
    await n.flush();
    expect(good.calls).toHaveLength(1);
  });
});
```

Plus `render.test.ts` asserting `renderEvent` produces a Discord `content` string containing the severity token and title, and includes serialized `detail`.

- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement.** `severity.ts`:

```ts
export type Severity = 'info' | 'warn' | 'critical';
export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };
export function meets(evt: Severity, min: Severity): boolean {
  return SEVERITY_ORDER[evt] >= SEVERITY_ORDER[min];
}
```

`render.ts`:

```ts
import type { NotifyEvent } from './types.js';
import type { Severity } from './severity.js';

export interface RenderedEvent {
  severity: Severity;
  kind: string;
  title: string;
  text: string;
  discordContent: string;
}
const EMOJI: Record<Severity, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };

export function renderEvent(e: NotifyEvent): RenderedEvent {
  const detailStr =
    e.detail && Object.keys(e.detail).length
      ? '\n' +
        Object.entries(e.detail)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n')
      : '';
  const text = `[${e.severity.toUpperCase()}] ${e.kind} — ${e.title}${detailStr}`;
  const discordContent = `${EMOJI[e.severity]} **[${e.severity.toUpperCase()}] ${e.title}**\n\`${e.kind}\`${detailStr}`;
  return { severity: e.severity, kind: e.kind, title: e.title, text, discordContent };
}
```

`notifier.ts` — fan-out awaits nothing in `notify()` (fire-and-forget); tracks in-flight promises so `flush()` can await them:

```ts
import type { Logger } from 'pino';
import type { Notifier, NotifyEvent, Sink } from './types.js';
import { meets } from './severity.js';
import { renderEvent } from './render.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

const LEVEL: Record<NotifyEvent['severity'], 'info' | 'warn' | 'error'> = {
  info: 'info',
  warn: 'warn',
  critical: 'error',
};

export function createNotifier(deps: { sinks: Sink[]; logger: Logger }): Notifier {
  const inFlight = new Set<Promise<void>>();
  return {
    notify(e: NotifyEvent): void {
      const rendered = renderEvent(e);
      deps.logger[LEVEL[e.severity]]({ kind: e.kind, ...e.detail }, e.title);
      for (const sink of deps.sinks) {
        if (!meets(e.severity, sink.minSeverity)) continue;
        const p = sink.send(rendered).catch((err: unknown) => {
          deps.logger.warn({ err, sink: sink.name }, 'notify sink failed');
        });
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
      }
    },
    async flush(): Promise<void> {
      await Promise.allSettled([...inFlight]);
    },
  };
}
// singleton assembled from config in Task 4 (sinks wired there); until then:
let _notifier: Notifier | null = null;
export function getNotifier(): Notifier {
  if (_notifier) return _notifier;
  // real sink assembly lands in Task 4; default to log-only.
  _notifier = createNotifier({ sinks: [], logger: getLogger() });
  return _notifier;
}
export function _resetNotifierForTest(): void {
  _notifier = null;
}
```

`sinks/log-sink.ts` — a no-op `send` (the notifier already logs every event via `deps.logger`); provided for symmetry/threshold config but effectively the always-on log is in the notifier. (Implementer: if cleaner, omit a separate log sink and keep the notifier's built-in logging as the "log sink"; document the choice.)

- [ ] **Step 4: Verify green; typecheck; lint.**
- [ ] **Step 5: Commit** — `feat(server): notifier core with severity-gated sink fan-out`.

---

## Task 3: Throttling / dedup

**Files:** Create `notify/throttle.ts` + test. Modify `notifier.ts` to apply the throttler.

**Interfaces — Produces:** `class Throttler { constructor(opts: { windowMs: number; now: () => number; maxKeys?: number }); admit(key: string): { send: boolean; suppressed: number } }`. `admit` returns `send:true` + the count suppressed since the last send when the window has elapsed (or first time); `send:false` otherwise, incrementing the suppressed counter. LRU-capped `maxKeys` (default 1000).

- [ ] **Step 1: Failing test** — injected clock:

```ts
import { Throttler } from './throttle.js';
describe('Throttler', () => {
  it('admits first, suppresses within window, re-admits after window with suppressed count', () => {
    let t = 1000;
    const th = new Throttler({ windowMs: 300_000, now: () => t });
    expect(th.admit('k')).toEqual({ send: true, suppressed: 0 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 1 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 2 });
    t += 300_001;
    expect(th.admit('k')).toEqual({ send: true, suppressed: 2 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 1 });
  });
  it('keys are independent', () => {
    const th = new Throttler({ windowMs: 1000, now: () => 0 });
    expect(th.admit('a').send).toBe(true);
    expect(th.admit('b').send).toBe(true);
  });
  it('evicts oldest beyond maxKeys', () => {
    let t = 0;
    const th = new Throttler({ windowMs: 1000, now: () => t, maxKeys: 2 });
    th.admit('a');
    t++;
    th.admit('b');
    t++;
    th.admit('c'); // 'a' evicted
    expect(th.admit('a')).toEqual({ send: true, suppressed: 0 }); // treated as fresh
  });
});
```

- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** `throttle.ts` (a `Map` used as LRU: delete+set on touch, evict oldest via first key when over cap). Each entry: `{ lastSent: number; suppressed: number }`.
- [ ] **Step 4: Wire into `notifier.ts`** — `createNotifier` gains an optional `throttler`. Before fan-out, `const { send, suppressed } = throttler.admit(e.dedupeKey ?? e.kind)`. If `!send`, log-only and return (do not hit push sinks). If `send` and `suppressed > 0`, add `suppressed_since_last: suppressed` to the rendered detail. The built-in logger line always runs (log sink is exempt from throttling). Add a notifier test proving the 2nd rapid same-key event does not reach a push sink but the 3rd (after clock advance) does, with the suppressed count in its payload.
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): notification throttling with suppressed-count summary`.

---

## Task 4: Webhook + SMTP sinks, and the real singleton assembly

**Files:** Create `notify/sinks/webhook-sink.ts`, `notify/sinks/smtp-sink.ts` + tests. Modify `notify/notifier.ts` `getNotifier()` to assemble sinks from config.

**Interfaces — Produces:** `createWebhookSink(opts: { url: string; minSeverity: Severity; timeoutMs: number; fetchImpl?: typeof fetch; logger: Logger }): Sink`; `createSmtpSink(opts: { send: SendEmailFn; recipients: string[]; minSeverity: Severity; from: string }): Sink`.

- [ ] **Step 1: Failing tests.** Webhook: injected `fetchImpl` captures the POST — assert URL, method POST, JSON `content` contains the title; assert an aborted/slow fetch is caught (sink `send` rejects → notifier catches; here test the sink directly rejects/throws is fine to surface, since the notifier wraps it — but the sink itself should still resolve or reject deterministically: make the sink swallow-and-log so `send` resolves). Decide: the sink's `send` rejects on non-2xx/timeout, and the _notifier_ swallows — test both (sink rejects on 500; notifier-level test in Task 2 already proves swallow). SMTP: `createSmtpSink` with empty recipients → building it returns a sink that is never registered (assembly skips it); with recipients, `send` calls the injected `SendEmailFn` once per recipient (or one mail with multiple `to`).

```ts
// webhook-sink.test.ts
it('POSTs a discord-shaped body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('', { status: 204 });
  }) as unknown as typeof fetch;
  const sink = createWebhookSink({
    url: 'https://d/hook',
    minSeverity: 'warn',
    timeoutMs: 1000,
    fetchImpl,
    logger,
  });
  await sink.send({
    severity: 'warn',
    kind: 'k',
    title: 'Disk 85%',
    text: '...',
    discordContent: 'X',
  });
  expect(calls[0].url).toBe('https://d/hook');
  expect(calls[0].init.method).toBe('POST');
  expect(JSON.parse(calls[0].init.body as string).content).toContain('X');
});
it('rejects on non-2xx', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const sink = createWebhookSink({
    url: 'https://d/hook',
    minSeverity: 'warn',
    timeoutMs: 1000,
    fetchImpl,
    logger,
  });
  await expect(
    sink.send({ severity: 'warn', kind: 'k', title: 't', text: 't', discordContent: 'X' }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement sinks.** Webhook uses `AbortController` + `setTimeout(timeoutMs)` (cleared in `finally`), body `{ content: rendered.discordContent }`, rejects on non-2xx. SMTP builds a `text` email (`subject = "[SEVERITY] title"`, `text = rendered.text`) to the recipient list.
- [ ] **Step 4: Assemble the singleton.** Rewrite `getNotifier()` to build sinks from `getConfig()`: always the built-in log; add webhook sink iff `ALERT_WEBHOOK_URL` set; add smtp sink iff `SMTP_URL !== ''` and `ALERT_EMAIL_RECIPIENTS.length > 0` (using `getRealEmailTransport`). Wire the throttler with `windowMs = ALERT_DEDUPE_WINDOW_SECONDS*1000`, `now: () => Date.now()`. Add a test that with `ALERT_WEBHOOK_URL` unset, no webhook sink is present (assemble via a test seam that accepts a config slice).
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): webhook + smtp notification sinks and singleton assembly`.

---

## Task 5: Crash handlers + lifecycle events

**Files:** Create `notify/fatal.ts` + test. Modify `packages/server/src/index.ts`.

**Interfaces — Produces:** `async function handleFatal(err: unknown, notifier: Notifier): Promise<void>` (notify critical `process.crash` with the error message/stack in detail, then `await notifier.flush()` with a bounded timeout); `function installCrashHandlers(notifier: Notifier): void` (registers `process.on('uncaughtException'|'unhandledRejection')` → `handleFatal` then `process.exit(1)`).

- [ ] **Step 1: Failing test** (`fatal.test.ts`) — a fake notifier records events; `await handleFatal(new Error('boom'), fake)` produces one `critical`/`process.crash` event whose detail includes `message: 'boom'`, and calls `flush`. (Do not test `process.exit`/signal registration in a unit test.)
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement `fatal.ts`.** `handleFatal` wraps `flush()` in `Promise.race([flush(), timeout(2000)])` so a hung sink can't block exit.
- [ ] **Step 4: Wire `index.ts`.** After successful boot, `getNotifier().notify({severity:'info', kind:'app.startup', title:'Provenance started', detail:{ sha: process.env.GIT_SHA, mode, backend, ... }})`. In the existing `shutdown()`, before draining: `getNotifier().notify({severity:'info', kind:'app.shutdown', title:`Shutting down (${signal})`})` then `await getNotifier().flush()`. Call `installCrashHandlers(getNotifier())` early. Keep the existing `.catch(process.exit(1))`.
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): crash + lifecycle notifications`.

---

## Task 6: Job-failure notifications

**Files:** Create `notify/job-failure.ts` + test. Modify `packages/server/src/jobs/worker.ts`.

**Interfaces — Produces:** `function withFailureNotification<T>(opts: { kind: string; severity: Severity; notifier: Notifier }, handler: (job: T) => Promise<void>): (job: T) => Promise<void>` — calls `handler`; on throw, if the job's retries are exhausted (`job.retryCount >= job.retryLimit`, reading pg-boss's job shape defensively), `notify`s then **rethrows**; if retries remain, rethrows without notifying.

- [ ] **Step 1: Failing test** — a fake job `{ retryCount, retryLimit }`; handler that throws. Assert: exhausted → one notify (kind, severity) + rethrow; not-exhausted → zero notify + rethrow; handler success → zero notify, no throw.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement.** Read `retryCount`/`retryLimit` off the job via a small typed shape with fallbacks (`?? 0`); if either is missing, treat a throw as exhausted (fail safe → notify). Detail includes `kind`, `retryCount`, and the error message.
- [ ] **Step 4: Wire `worker.ts`.** Add `boss.on('error', (err) => getNotifier().notify({ severity:'critical', kind:'pgboss.error', title:'pg-boss error', detail:{ message: String(err) } }))` where the boss instance is created/started (or in `pg-boss.ts`'s `boss.on('error')` handler — augment, don't replace the existing log). Wrap the cron/job `boss.work` handlers whose failure matters (ingest finalize / recompute / cross-flags / retention / reaper) with `withFailureNotification({ kind:'job.dead_letter', severity:'warn', notifier: getNotifier() }, handler)`. Do not change retry/dead-letter config.
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): job-failure and pg-boss error notifications`.

---

## Self-Review Checklist (run after writing all tasks)

- Every event in the spec's catalog maps to a task: process.crash (T5), pgboss.error (T6), job.dead_letter (T6), app.startup/app.shutdown (T5). Quota/blob-write events belong to the deployment feature (not here) — noted.
- `Severity`/`meets` used consistently across notifier, sinks, throttler.
- `notify()` never throws (T2 test) and never blocks (fire-and-forget; `flush` only awaited on shutdown/crash).
- Throttler clock injected; no `Date.now()` in assertions.
- No new deps; webhook uses global `fetch` (injectable), smtp reuses `email/transport.ts`.
