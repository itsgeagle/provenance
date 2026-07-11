import { describe, it, expect } from 'vitest';
import { startupEvent, shutdownEvent } from './lifecycle.js';

describe('startupEvent', () => {
  it('names the role in the title so api/worker are distinguishable in the webhook', () => {
    const e = startupEvent({ mode: 'worker', sha: 'a86ce59', backend: 'fs', host: 'ct-abc123' });
    expect(e.kind).toBe('app.startup');
    expect(e.severity).toBe('info');
    expect(e.title).toContain('worker');
    expect(e.detail).toMatchObject({
      mode: 'worker',
      sha: 'a86ce59',
      backend: 'fs',
      host: 'ct-abc123',
    });
  });

  it('falls back to "unknown" when the sha is undefined', () => {
    const e = startupEvent({ mode: 'api', sha: undefined, backend: 's3', host: 'h' });
    expect(e.detail?.sha).toBe('unknown');
  });

  it('distinguishes the api role in its title', () => {
    expect(startupEvent({ mode: 'api', sha: 'x', backend: 'fs', host: 'h' }).title).toContain(
      'api',
    );
  });
});

describe('shutdownEvent', () => {
  it('names the role and signal, and carries the host', () => {
    const e = shutdownEvent({ mode: 'worker', signal: 'SIGTERM', host: 'ct-abc123' });
    expect(e.kind).toBe('app.shutdown');
    expect(e.severity).toBe('info');
    expect(e.title).toContain('worker');
    expect(e.title).toContain('SIGTERM');
    expect(e.detail).toMatchObject({ mode: 'worker', host: 'ct-abc123' });
  });
});
