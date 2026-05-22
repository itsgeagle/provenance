/**
 * Storage client factory.
 *
 * Returns an `AwsClient` pre-configured with the OBJECT_STORAGE_* env vars.
 * The client is a thin SigV4 wrapper over `fetch` and works against any
 * S3-compatible endpoint (AWS S3, Cloudflare R2, MinIO, etc.).
 *
 * One instance per process is sufficient — `AwsClient` is stateless except for
 * a credential cache (a plain `Map`) that's safe to share across calls.
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../../config/env.js';

export interface StorageClientConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Build a `StorageClientConfig` from a validated `Env` object.
 * Tests call `createStorageClient(configFromEnvSlice(...))` so they never
 * touch `process.env` directly.
 */
export function storageConfigFromEnv(env: Env): StorageClientConfig {
  return {
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  };
}

export interface StorageClient {
  /** `aws4fetch` `AwsClient` for signing requests. */
  aws: AwsClient;
  /** Resolved bucket endpoint, e.g. `http://localhost:9000/provenance`. */
  bucketUrl: string;
}

/**
 * Create a storage client from an explicit config slice.
 * The caller is responsible for obtaining config (e.g. via `getConfig()`).
 */
export function createStorageClient(cfg: StorageClientConfig): StorageClient {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
    // Disable automatic retries: callers decide retry policy at their layer.
    retries: 0,
  });

  // Normalise the endpoint to avoid double-slash when concatenating keys.
  const base = cfg.endpoint.endsWith('/') ? cfg.endpoint.slice(0, -1) : cfg.endpoint;
  const bucketUrl = `${base}/${cfg.bucket}`;

  return { aws, bucketUrl };
}
