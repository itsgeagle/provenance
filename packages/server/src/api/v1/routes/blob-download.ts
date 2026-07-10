/**
 * GET /api/v1/blob — self-authenticating blob download for the fs backend.
 *
 * The HMAC token in the query string IS the credential (no session/token auth),
 * mirroring S3 presigned-URL semantics: an unauthenticated, TTL-bounded read of
 * one blob key. Only fs-backend presigned URLs point here; under the s3 backend
 * nothing mints these URLs, so the route is never exercised.
 */

import { Hono, type Context } from 'hono';
import { verifyBlobUrl } from '../../../services/storage/fs-blobs.js';
import { getBlob } from '../../../services/storage/blobs.js';
import { getStorageClient } from '../../../services/storage/default-client.js';
import type { StorageClient } from '../../../services/storage/client.js';

export function createBlobDownloadRouter(getClient: () => StorageClient = getStorageClient): Hono {
  const router = new Hono();

  const handler = async (c: Context): Promise<Response> => {
    const d = c.req.query('d');
    const s = c.req.query('s');
    if (!d || !s) {
      return c.json({ error: 'missing signature parameters' }, 400);
    }

    const client = getClient();
    if (client.kind !== 'fs') {
      // Route only meaningful under the fs backend.
      return c.json({ error: 'not found' }, 404);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const verdict = verifyBlobUrl(client.signingSecret, d, s, nowSec);
    if (!verdict.ok) {
      return c.json({ error: 'invalid or expired link' }, 403);
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await getBlob(client, verdict.key);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }

    c.header('content-type', 'application/octet-stream');
    return c.body(stream);
  };

  // Mounted at '/' inside createV1App(), which createApp() mounts at
  // '/api/v1' — so this single registration resolves to '/api/v1/blob' in
  // production. Tests mirror that mount chain rather than faking the prefix.
  router.get('/blob', handler);

  return router;
}
