import type { Logger } from 'pino';
import type { Notifier, NotifyEvent, Sink } from './types.js';
import { meets } from './severity.js';
import { renderEvent } from './render.js';
import { getLogger } from '../logging.js';
import type { Throttler } from './throttle.js';

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
        try {
          // Wrap in Promise.resolve() so a sink that violates its contract by
          // throwing synchronously (instead of rejecting) is caught the same
          // way as a normal async rejection.
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

// Module-level singleton, mirroring getLogger()/getConfig(). Real sink
// assembly (webhook/smtp, wired from ALERT_* config) lands in a later task;
// until then this is log-only.
let _notifier: Notifier | null = null;

export function getNotifier(): Notifier {
  if (_notifier) return _notifier;
  _notifier = createNotifier({ sinks: [], logger: getLogger() });
  return _notifier;
}

export function _resetNotifierForTest(): void {
  _notifier = null;
}
