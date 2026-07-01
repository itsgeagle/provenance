/**
 * getStorageClient — construct a StorageClient from the process config.
 *
 * Convenience for the many read paths that now fetch the stored bundle blob on
 * demand (events API, file reconstruction, recompute, cross-flags, summary).
 * Mirrors the inline `createStorageClient(storageConfigFromEnv(getConfig()))`
 * used by the existing upload/download routes.
 */

import { createStorageClient, storageConfigFromEnv } from './client.js';
import type { StorageClient } from './client.js';
import { getConfig } from '../../config/index.js';

export function getStorageClient(): StorageClient {
  return createStorageClient(storageConfigFromEnv(getConfig()));
}
