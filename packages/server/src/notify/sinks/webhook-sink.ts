import type { Logger } from 'pino';
import type { Sink } from '../types.js';
import type { RenderedEvent } from '../render.js';
import type { Severity } from '../severity.js';

/**
 * A push sink that POSTs a Discord incoming-webhook-shaped JSON body
 * (`{ content: "..." }`, which Slack-compatible webhooks also accept) to a
 * configured URL. `send()` rejects on a non-2xx response or a timed-out /
 * aborted request; the notifier's fan-out loop catches and logs that
 * rejection per-sink, so one dead webhook never breaks other sinks.
 *
 * `fetchImpl` defaults to the global `fetch` and is injectable for tests.
 */
export function createWebhookSink(opts: {
  url: string;
  minSeverity: Severity;
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
  logger: Logger;
}): Sink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    name: 'webhook',
    minSeverity: opts.minSeverity,
    async send(rendered: RenderedEvent): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const res = await fetchImpl(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: rendered.discordContent }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`webhook POST failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        opts.logger.debug({ err, url: opts.url }, 'webhook sink: send failed');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
