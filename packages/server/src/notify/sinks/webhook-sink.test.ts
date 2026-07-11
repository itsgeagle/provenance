import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createWebhookSink } from './webhook-sink.js';
import type { RenderedEvent } from '../render.js';

const logger = pino({ enabled: false });

function event(overrides: Partial<RenderedEvent> = {}): RenderedEvent {
  return {
    severity: 'warn',
    kind: 'k',
    title: 'Disk 85%',
    text: 'plain text body',
    discordContent: 'X content',
    ...overrides,
  };
}

describe('createWebhookSink', () => {
  it('POSTs a discord-shaped JSON body to the configured URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const sink = createWebhookSink({
      url: 'https://d/hook',
      minSeverity: 'warn',
      timeoutMs: 1000,
      fetchImpl,
      logger,
    });
    await sink.send(event());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://d/hook');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init.body as string) as { content: string };
    expect(body.content).toContain('X content');
  });

  it('rejects on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const sink = createWebhookSink({
      url: 'https://d/hook',
      minSeverity: 'warn',
      timeoutMs: 1000,
      fetchImpl,
      logger,
    });
    await expect(sink.send(event())).rejects.toThrow();
  });

  it('clears the abort timer after a successful send (no leaked timer)', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async () =>
        new Response(null, { status: 204 })) as unknown as typeof fetch;
      const sink = createWebhookSink({
        url: 'https://d/hook',
        minSeverity: 'warn',
        timeoutMs: 1000,
        fetchImpl,
        logger,
      });
      await sink.send(event());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and rejects when the fetch exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch;
      const sink = createWebhookSink({
        url: 'https://d/hook',
        minSeverity: 'warn',
        timeoutMs: 50,
        fetchImpl,
        logger,
      });
      const pending = expect(sink.send(event())).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults fetchImpl to global fetch when not provided', () => {
    const sink = createWebhookSink({
      url: 'https://d/hook',
      minSeverity: 'warn',
      timeoutMs: 1000,
      logger,
    });
    expect(sink.name).toBe('webhook');
    expect(sink.minSeverity).toBe('warn');
  });
});
