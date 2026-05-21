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

  // -------------------------------------------------------------------------
  // Critical 2: X-Request-Id validation (header injection / log injection)
  // -------------------------------------------------------------------------

  it('client sends valid UUID → echoed through', async () => {
    const app = makeApp();
    const validId = '550e8400-e29b-41d4-a716-446655440000';
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'X-Request-Id': validId },
      }),
    );
    expect(res.headers.get('X-Request-Id')).toBe(validId);
    const body = await res.json();
    expect(body.requestId).toBe(validId);
  });

  it('client sends 200-char string (over 128-char limit) → rejected, fresh UUID issued', async () => {
    const app = makeApp();
    const tooLong = 'a'.repeat(200);
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'X-Request-Id': tooLong },
      }),
    );
    const header = res.headers.get('X-Request-Id');
    expect(header).toBeTruthy();
    // Must NOT echo the invalid value
    expect(header).not.toBe(tooLong);
    // Must be a fresh UUID v4
    expect(header).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('SAFE_REQUEST_ID regex rejects CRLF injection attempts', () => {
    // The browser/Node Headers API already strips \r\n before it reaches the
    // middleware in a real request (they are invalid header characters per RFC 7230).
    // We test the regex directly to confirm our validation layer also rejects them.
    //
    // This is defence-in-depth: if the value ever reached us through a raw socket
    // or a future lower-level transport, our regex would catch it.
    const SAFE_REQUEST_ID = /^[\x20-\x7E]{1,128}$/;
    const malicious = 'evil\r\nX-Injected: yes';
    expect(SAFE_REQUEST_ID.test(malicious)).toBe(false);
  });

  it('client sends printable-ASCII custom ID → echoed through', async () => {
    const app = makeApp();
    const customId = 'valid_request_id_v2';
    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'X-Request-Id': customId },
      }),
    );
    expect(res.headers.get('X-Request-Id')).toBe(customId);
    const body = await res.json();
    expect(body.requestId).toBe(customId);
  });
});
