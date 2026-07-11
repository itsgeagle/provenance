import type { Logger } from 'pino';
import type { Notifier, NotifyEvent, Sink } from './types.js';
import type { Severity } from './severity.js';
import { meets } from './severity.js';
import { renderEvent } from './render.js';
import { getLogger } from '../logging.js';
import { getConfig } from '../config/index.js';
import { Throttler } from './throttle.js';
import { createWebhookSink } from './sinks/webhook-sink.js';
import { createSmtpSink } from './sinks/smtp-sink.js';
import { getRealEmailTransport, type SendEmailFn } from '../email/transport.js';

const LEVEL: Record<NotifyEvent['severity'], 'info' | 'warn' | 'error'> = {
  info: 'info',
  warn: 'warn',
  critical: 'error',
};

/**
 * Builds a Notifier that always logs every event (so it's at least in the
 * journal) and fans out to `sinks` whose threshold the event's severity meets.
 * `notify()` never throws and never blocks the caller: sink sends are
 * fire-and-forget, with failures caught and logged per-sink. `flush()` awaits
 * all in-flight sink sends.
 *
 * When `throttler` is supplied, repeated events sharing a key (`dedupeKey`,
 * falling back to `kind`) within the throttle window are logged (the
 * built-in log line is exempt from throttling) but not fanned out to push
 * sinks. The first event admitted after a suppressed run carries a
 * `suppressed_since_last` count in the detail sent to sinks.
 */
export function createNotifier(deps: {
  sinks: Sink[];
  logger: Logger;
  throttler?: Throttler;
}): Notifier {
  const inFlight = new Set<Promise<void>>();
  return {
    notify(e: NotifyEvent): void {
      deps.logger[LEVEL[e.severity]]({ kind: e.kind, ...e.detail }, e.title);

      const { send, suppressed } = deps.throttler
        ? deps.throttler.admit(e.dedupeKey ?? e.kind)
        : { send: true, suppressed: 0 };
      if (!send) return; // log-only: skip push sinks

      const eventForSinks =
        suppressed > 0 ? { ...e, detail: { ...e.detail, suppressed_since_last: suppressed } } : e;
      const rendered = renderEvent(eventForSinks);
      for (const sink of deps.sinks) {
        if (!meets(e.severity, sink.minSeverity)) continue;
        // Two isolation layers, both required — do not remove either:
        //  - the try/catch catches a sink that violates its contract by throwing
        //    SYNCHRONOUSLY (the throw happens while evaluating sink.send(), before
        //    Promise.resolve() is ever reached);
        //  - Promise.resolve(...).catch() catches a normal async REJECTION.
        try {
          const p = Promise.resolve(sink.send(rendered)).catch((err: unknown) => {
            deps.logger.warn({ err, sink: sink.name }, 'notify sink failed');
          });
          inFlight.add(p);
          void p.finally(() => inFlight.delete(p));
        } catch (err) {
          deps.logger.warn({ err, sink: sink.name }, 'notify sink failed');
        }
      }
    },
    async flush(): Promise<void> {
      await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * The slice of `Env` that sink assembly depends on. Kept as an explicit type
 * (rather than importing `Env` directly) so `assembleSinks` can be unit
 * tested with a plain object literal instead of the full parsed config.
 */
export interface SinkAssemblyConfig {
  ALERT_WEBHOOK_URL?: string | undefined;
  ALERT_WEBHOOK_MIN_SEVERITY: Severity;
  ALERT_WEBHOOK_TIMEOUT_MS: number;
  SMTP_URL: string;
  SMTP_FROM: string;
  ALERT_EMAIL_RECIPIENTS: string[];
  ALERT_SMTP_MIN_SEVERITY: Severity;
}

/**
 * Builds the push-sink list from a config slice. Pure with respect to
 * `process.env`/wall clock: callers inject `fetchImpl`/`emailSend` for
 * tests, and pass real deps at the `getNotifier()` call site. Gating:
 *   - webhook sink added iff `ALERT_WEBHOOK_URL` is set.
 *   - smtp sink added iff `SMTP_URL !== ''` and `ALERT_EMAIL_RECIPIENTS` is non-empty.
 * Does not include the built-in log sink — that's inline in `createNotifier`.
 */
export function assembleSinks(
  cfg: SinkAssemblyConfig,
  deps: {
    logger: Logger;
    fetchImpl?: typeof fetch | undefined;
    emailSend?: SendEmailFn | undefined;
  },
): Sink[] {
  const sinks: Sink[] = [];

  if (cfg.ALERT_WEBHOOK_URL) {
    sinks.push(
      createWebhookSink({
        url: cfg.ALERT_WEBHOOK_URL,
        minSeverity: cfg.ALERT_WEBHOOK_MIN_SEVERITY,
        timeoutMs: cfg.ALERT_WEBHOOK_TIMEOUT_MS,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
      }),
    );
  }

  if (cfg.SMTP_URL !== '' && cfg.ALERT_EMAIL_RECIPIENTS.length > 0) {
    const send =
      deps.emailSend ?? getRealEmailTransport({ SMTP_URL: cfg.SMTP_URL, SMTP_FROM: cfg.SMTP_FROM });
    sinks.push(
      createSmtpSink({
        send,
        recipients: cfg.ALERT_EMAIL_RECIPIENTS,
        minSeverity: cfg.ALERT_SMTP_MIN_SEVERITY,
        from: cfg.SMTP_FROM,
      }),
    );
  }

  return sinks;
}

// Module-level singleton, mirroring getLogger()/getConfig().
let _notifier: Notifier | null = null;

export function getNotifier(): Notifier {
  if (_notifier) return _notifier;
  const cfg = getConfig();
  const logger = getLogger();
  const sinks = assembleSinks(cfg, { logger });
  const throttler = new Throttler({
    windowMs: cfg.ALERT_DEDUPE_WINDOW_SECONDS * 1000,
    now: () => Date.now(),
  });
  _notifier = createNotifier({ sinks, logger, throttler });
  return _notifier;
}

export function _resetNotifierForTest(): void {
  _notifier = null;
}
