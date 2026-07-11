import { describe, it, expect } from 'vitest';
import { createNotifier } from './notifier.js';
import type { Sink } from './types.js';
import type { RenderedEvent } from './render.js';
import pino from 'pino';

function fakeSink(name: string, minSeverity: 'info' | 'warn' | 'critical'): Sink & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { name, minSeverity, calls, send: async (r) => { calls.push(r); } };
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
    const bad: Sink = { name: 'bad', minSeverity: 'info', send: async () => { throw new Error('x'); } };
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
