/**
 * reap-stale-uploads — daily cron.
 *
 * Reclaims multipart staging dirs abandoned by a crashed upload (the normal
 * failure path already calls abort). No-op under the s3 backend. Only deletes
 * transient staging under <rootDir>/.uploads — never stored bundles or DB rows.
 */

import { reapStaleUploads } from '../services/storage/fs-multipart.js';
import type { StorageClient } from '../services/storage/client.js';
import { getLogger } from '../logging.js';

export function createReapStaleUploadsHandler(
  storage: StorageClient,
  maxAgeMs: number,
): () => Promise<void> {
  return async () => {
    const res = await reapStaleUploads(storage, { now: Date.now(), maxAgeMs });
    if (res.reaped > 0 || res.errors > 0) {
      getLogger().info(res, 'reap-stale-uploads: sweep complete');
    }
  };
}
