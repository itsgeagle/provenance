import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobDownloadRouter } from './blob-download.js';
import { fsPutBlob, signBlobUrl } from '../../../services/storage/fs-blobs.js';
import type { StorageClient } from '../../../services/storage/client.js';

const SECRET = 'z'.repeat(32);

async function setup(): Promise<{
  client: Extract<StorageClient, { kind: 'fs' }>;
  app: ReturnType<typeof createBlobDownloadRouter>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-blobroute-'));
  const client: Extract<StorageClient, { kind: 'fs' }> = {
    kind: 'fs',
    rootDir,
    signingSecret: SECRET,
    publicBaseUrl: 'http://host',
  };
  // Inject the client via a factory arg so the test needs no env/config.
  const app = createBlobDownloadRouter(() => client);
  return { client, app };
}

function farFuture(): number {
  return 4_000_000_000;
}

describe('GET /api/v1/blob', () => {
  it('streams the blob for a valid token', async () => {
    const { client, app } = await setup();
    try {
      const data = new Uint8Array([1, 2, 3, 4]);
      await fsPutBlob(client, 'a/b.zip', data);
      const { d, s } = signBlobUrl(SECRET, 'a/b.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for an expired token', async () => {
    const { client, app } = await setup();
    try {
      await fsPutBlob(client, 'a/b.zip', new Uint8Array([9]));
      const { d, s } = signBlobUrl(SECRET, 'a/b.zip', 1); // exp in the past
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(403);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for a tampered signature', async () => {
    const { client, app } = await setup();
    try {
      await fsPutBlob(client, 'a/b.zip', new Uint8Array([9]));
      const { d } = signBlobUrl(SECRET, 'a/b.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=deadbeef`);
      expect(res.status).toBe(403);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a valid token to a missing file', async () => {
    const { client, app } = await setup();
    try {
      const { d, s } = signBlobUrl(SECRET, 'gone.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(404);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when d or s is missing', async () => {
    const { client, app } = await setup();
    try {
      const res = await app.request(`/api/v1/blob?d=only-d`);
      expect(res.status).toBe(400);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });
});
