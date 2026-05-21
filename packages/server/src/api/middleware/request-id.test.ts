/**
 * Request ID middleware tests.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestId } from './request-id.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', requestId);
  app.get('/test', (c) => {
    return c.json({ requestId: c.var.requestId });
  });
  return app;
}

describe('requestId middleware', () => {
  it('generates a UUID v4 and sets it on c.var.requestId', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://localhost/test'));
    const body = await res.json();
    expect(body.requestId).toBeTruthy();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('sets X-Request-Id response header', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://localhost/test'));
    const header = res.headers.get('X-Request-Id');
    expect(header).toBeTruthy();
    expect(header).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('echoes client-provided X-Request-Id (distributed tracing)', async () => {
    const app = makeApp();
    const clientId = 'trace-id-from-upstream-12345678';
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'X-Request-Id': clientId },
      }),
    );
    expect(res.headers.get('X-Request-Id')).toBe(clientId);
    const body = await res.json();
    expect(body.requestId).toBe(clientId);
  });

  it('generates a new UUID for each request (no sharing between requests)', async () => {
    const app = makeApp();
    const [res1, res2] = await Promise.all([
      app.fetch(new Request('http://localhost/test')),
      app.fetch(new Request('http://localhost/test')),
    ]);
    const id1 = res1.headers.get('X-Request-Id');
    const id2 = res2.headers.get('X-Request-Id');
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('c.var.requestId matches X-Request-Id header', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://localhost/test'));
    const header = res.headers.get('X-Request-Id');
    const body = await res.json();
    expect(body.requestId).toBe(header);
  });
});
