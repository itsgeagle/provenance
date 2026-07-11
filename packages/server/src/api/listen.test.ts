import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveListenTarget, prepareSocket, makeWorldWritable } from './listen.js';

describe('resolveListenTarget', () => {
  it('prefers socket when SOCKET_PATH set', () => {
    expect(resolveListenTarget({ SOCKET_PATH: '/run/app.sock', PORT: 3000 })).toEqual({
      kind: 'socket',
      path: '/run/app.sock',
    });
  });

  it('falls back to tcp port when SOCKET_PATH unset', () => {
    expect(resolveListenTarget({ SOCKET_PATH: undefined, PORT: 3000 })).toEqual({
      kind: 'tcp',
      port: 3000,
    });
  });

  it('falls back to tcp port when SOCKET_PATH is an empty string', () => {
    expect(resolveListenTarget({ SOCKET_PATH: '', PORT: 3000 })).toEqual({
      kind: 'tcp',
      port: 3000,
    });
  });
});

describe('prepareSocket', () => {
  it('unlinks an existing socket file', () => {
    const unlinked: string[] = [];
    prepareSocket('/run/app.sock', {
      existsSync: () => true,
      unlinkSync: (p: string) => unlinked.push(p),
    });
    expect(unlinked).toEqual(['/run/app.sock']);
  });

  it('is a no-op when no file exists', () => {
    const unlinked: string[] = [];
    prepareSocket('/run/app.sock', {
      existsSync: () => false,
      unlinkSync: (p: string) => unlinked.push(p),
    });
    expect(unlinked).toEqual([]);
  });
});

describe('makeWorldWritable', () => {
  it('chmods 0o777', () => {
    const calls: Array<[string, number]> = [];
    makeWorldWritable('/run/app.sock', {
      chmodSync: (p: string, m: number) => calls.push([p, m]),
    });
    expect(calls).toEqual([['/run/app.sock', 0o777]]);
  });
});

// ---------------------------------------------------------------------------
// Integration: bind a real Unix domain socket in a tmp dir, round-trip an
// actual HTTP request over it, and assert the socket file is world-writable.
// Deterministic and fast — no Docker, no external deps.
// ---------------------------------------------------------------------------

describe('real unix socket (integration)', () => {
  let server: Server | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('serves a request over the socket and leaves it world-writable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'provenance-listen-test-'));
    const socketPath = join(dir, 'app.sock');

    const fetchHandler = (): Response => new Response('ok', { status: 200 });
    server = createServer(getRequestListener(fetchHandler));

    prepareSocket(socketPath); // no-op: nothing bound yet, mirrors startApi()'s ordering
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    makeWorldWritable(socketPath);

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ socketPath, path: '/', method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });

    expect(body).toBe('ok');
    expect(statSync(socketPath).mode & 0o777).toBe(0o777);
  });
});
