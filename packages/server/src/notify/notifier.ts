import type { Logger } from 'pino';
import type { Notifier, NotifyEvent, Sink } from './types.js';
import { meets } from './severity.js';
import { renderEvent } from './render.js';
import { getLogger } from '../logging.js';

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
 */
export function createNotifier(deps: { sinks: Sink[]; logger: Logger }): Notifier {
  const inFlight = new Set<Promise<void>>();
  return {
    notify(e: NotifyEvent): void {
      const rendered = renderEvent(e);
      deps.logger[LEVEL[e.severity]]({ kind: e.kind, ...e.detail }, e.title);
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
