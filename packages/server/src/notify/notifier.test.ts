import { describe, it, expect } from 'vitest';
import { createNotifier, assembleSinks, type SinkAssemblyConfig } from './notifier.js';
import { Throttler } from './throttle.js';
import type { Sink } from './types.js';
import type { RenderedEvent } from './render.js';
import type { SendEmailArgs } from '../email/transport.js';
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
  it('a sink that throws synchronously (not just rejects) does not stop the others and does not throw to caller', async () => {
    // send is typed to return Promise<void>, but a buggy implementation could
    // still throw before ever returning a promise; notify() must survive that too.
    const badSync: Sink = {
      name: 'bad-sync',
      minSeverity: 'info',
      send: (_rendered: RenderedEvent): Promise<void> => {
        throw new Error('sync boom');
      },
    };
    const good = fakeSink('good', 'info');
    const n = createNotifier({ sinks: [badSync, good], logger });
    expect(() => n.notify({ severity: 'critical', kind: 'k', title: 't' })).not.toThrow();
    await n.flush();
    expect(good.calls).toHaveLength(1);
  });
});

describe('createNotifier throttling', () => {
  it('suppresses a rapid repeat of the same key from push sinks, but admits it again after the window with the suppressed count in the payload', async () => {
    let t = 1000;
    const throttler = new Throttler({ windowMs: 300_000, now: () => t });
    const sink = fakeSink('push', 'info');
    const n = createNotifier({ sinks: [sink], logger, throttler });

    n.notify({ severity: 'warn', kind: 'job.dead_letter', title: 'first' });
    n.notify({ severity: 'warn', kind: 'job.dead_letter', title: 'second' }); // within window, suppressed
    await n.flush();
    expect(sink.calls).toHaveLength(1);

    t += 300_001; // advance past the window
    n.notify({ severity: 'warn', kind: 'job.dead_letter', title: 'third' });
    await n.flush();
    expect(sink.calls).toHaveLength(2);
    const third = sink.calls[1] as RenderedEvent;
    expect(third.text).toContain('suppressed_since_last: 1');
  });

  it('the built-in logger line always runs, even for a throttled (log-only) event', async () => {
    const t = 1000;
    const throttler = new Throttler({ windowMs: 300_000, now: () => t });
    const sink = fakeSink('push', 'info');
    const logCalls: unknown[] = [];
    const spyLogger = pino({ enabled: false });
    spyLogger.warn = ((...args: unknown[]) => {
      logCalls.push(args);
    }) as typeof spyLogger.warn;
    const n = createNotifier({ sinks: [sink], logger: spyLogger, throttler });

    n.notify({ severity: 'warn', kind: 'job.dead_letter', title: 'first' });
    n.notify({ severity: 'warn', kind: 'job.dead_letter', title: 'second' });
    await n.flush();

    expect(logCalls).toHaveLength(2); // both logged
    expect(sink.calls).toHaveLength(1); // only the first reached the push sink
  });
});

function baseAssemblyConfig(overrides: Partial<SinkAssemblyConfig> = {}): SinkAssemblyConfig {
  return {
    ALERT_WEBHOOK_URL: undefined,
    ALERT_WEBHOOK_MIN_SEVERITY: 'warn',
    ALERT_WEBHOOK_TIMEOUT_MS: 5000,
    SMTP_URL: '',
    SMTP_FROM: '',
    ALERT_EMAIL_RECIPIENTS: [],
    ALERT_SMTP_MIN_SEVERITY: 'critical',
    ...overrides,
  };
}

describe('assembleSinks', () => {
  it('omits the webhook sink when ALERT_WEBHOOK_URL is unset', () => {
    const sinks = assembleSinks(baseAssemblyConfig(), { logger });
    expect(sinks.map((s) => s.name)).not.toContain('webhook');
  });

  it('includes the webhook sink when ALERT_WEBHOOK_URL is set', () => {
    const sinks = assembleSinks(baseAssemblyConfig({ ALERT_WEBHOOK_URL: 'https://d/hook' }), {
      logger,
      fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });
    expect(sinks.map((s) => s.name)).toContain('webhook');
  });

  it('omits the smtp sink when SMTP_URL is empty even with recipients configured', () => {
    const sinks = assembleSinks(
      baseAssemblyConfig({ SMTP_URL: '', ALERT_EMAIL_RECIPIENTS: ['a@x.com'] }),
      { logger },
    );
    expect(sinks.map((s) => s.name)).not.toContain('smtp');
  });

  it('omits the smtp sink when recipients is empty even with SMTP_URL configured', () => {
    const sinks = assembleSinks(
      baseAssemblyConfig({ SMTP_URL: 'smtp://localhost:1025', ALERT_EMAIL_RECIPIENTS: [] }),
      { logger },
    );
    expect(sinks.map((s) => s.name)).not.toContain('smtp');
  });

  it('includes the smtp sink when SMTP_URL is set and recipients is non-empty, using the injected emailSend', async () => {
    const calls: SendEmailArgs[] = [];
    const emailSend = async (args: SendEmailArgs): Promise<void> => {
      calls.push(args);
    };
    const sinks = assembleSinks(
      baseAssemblyConfig({
        SMTP_URL: 'smtp://localhost:1025',
        ALERT_EMAIL_RECIPIENTS: ['a@x.com'],
      }),
      { logger, emailSend },
    );
    const smtpSink = sinks.find((s) => s.name === 'smtp');
    expect(smtpSink).toBeDefined();
    await smtpSink?.send({
      severity: 'critical',
      kind: 'k',
      title: 't',
      text: 't',
      discordContent: 'X',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('a@x.com');
  });
});
