import type { Sink } from '../types.js';
import type { RenderedEvent } from '../render.js';
import type { Severity } from '../severity.js';
import type { SendEmailFn } from '../../email/transport.js';

/**
 * A push sink that emails `rendered.text` to a fixed recipient list via an
 * injected `SendEmailFn` (see `email/transport.ts`). One mail per recipient,
 * sent concurrently — recipients are independent, so there's no ordering
 * requirement between them.
 *
 * `from` is accepted for interface parity with the design's sink shape; the
 * injected `send` (built from `getRealEmailTransport`) already applies
 * `SMTP_FROM` internally, so this sink does not need to thread it through.
 */
export function createSmtpSink(opts: {
  send: SendEmailFn;
  recipients: string[];
  minSeverity: Severity;
  from: string;
}): Sink {
  return {
    name: 'smtp',
    minSeverity: opts.minSeverity,
    async send(rendered: RenderedEvent): Promise<void> {
      const subject = `[${rendered.severity.toUpperCase()}] ${rendered.title}`;
      await Promise.all(
        opts.recipients.map((to) => opts.send({ to, subject, text: rendered.text })),
      );
    },
  };
}
