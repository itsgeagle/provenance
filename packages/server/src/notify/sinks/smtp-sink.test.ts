import { describe, it, expect } from 'vitest';
import { createSmtpSink } from './smtp-sink.js';
import type { SendEmailArgs } from '../../email/transport.js';
import type { RenderedEvent } from '../render.js';

function event(overrides: Partial<RenderedEvent> = {}): RenderedEvent {
  return {
    severity: 'critical',
    kind: 'k',
    title: 'Disk 95%',
    text: 'body text',
    discordContent: 'X',
    ...overrides,
  };
}

describe('createSmtpSink', () => {
  it('sends a plain-text mail to each recipient', async () => {
    const calls: SendEmailArgs[] = [];
    const send = async (args: SendEmailArgs): Promise<void> => {
      calls.push(args);
    };
    const sink = createSmtpSink({
      send,
      recipients: ['a@x.com', 'b@x.com'],
      minSeverity: 'critical',
      from: 'noreply@x.com',
    });

    await sink.send(event());

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.to).sort()).toEqual(['a@x.com', 'b@x.com']);
    for (const c of calls) {
      expect(c.subject).toBe('[CRITICAL] Disk 95%');
      expect(c.text).toBe('body text');
    }
  });

  it('calls send zero times when recipients is empty', async () => {
    const calls: SendEmailArgs[] = [];
    const send = async (args: SendEmailArgs): Promise<void> => {
      calls.push(args);
    };
    const sink = createSmtpSink({
      send,
      recipients: [],
      minSeverity: 'critical',
      from: 'noreply@x.com',
    });

    await sink.send(event());

    expect(calls).toHaveLength(0);
  });

  it('exposes name and minSeverity for fan-out gating', () => {
    const sink = createSmtpSink({
      send: async () => {},
      recipients: ['a@x.com'],
      minSeverity: 'warn',
      from: 'noreply@x.com',
    });
    expect(sink.name).toBe('smtp');
    expect(sink.minSeverity).toBe('warn');
  });
});
