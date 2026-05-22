/**
 * Testcontainers harness for MinIO integration tests.
 *
 * Usage:
 *   import { withTestMinio } from '../../test/helpers/minio.js';
 *
 *   it('can put and get an object', async () => {
 *     await withTestMinio(async ({ client, bucketName }) => {
 *       // client is a StorageClient wired to the ephemeral MinIO instance.
 *       // bucketName is the pre-created bucket name ('test-bucket').
 *     });
 *   });
 *
 * Requirements:
 * - Docker must be running.
 * - Each `withTestMinio` call gets its own isolated MinIO container.
 *   Container teardown is guaranteed even if `fn` throws.
 */

import { MinioContainer } from '@testcontainers/minio';
import { createStorageClient, type StorageClient } from '../../src/services/storage/client.js';

const MINIO_IMAGE = 'minio/minio:latest';
const MINIO_USER = 'minioadmin';
const MINIO_PASSWORD = 'minioadmin';
const BUCKET_NAME = 'test-bucket';

export interface TestMinioContext {
  client: StorageClient;
  bucketName: string;
}

/**
 * Spawns a MinIO container, creates the test bucket, then calls `fn` with a
 * bound `StorageClient`. Tears down on completion even if `fn` throws.
 *
 * Isolation level: one container per `withTestMinio` call.
 */
export async function withTestMinio(fn: (ctx: TestMinioContext) => Promise<void>): Promise<void> {
  const container = await new MinioContainer(MINIO_IMAGE)
    .withUsername(MINIO_USER)
    .withPassword(MINIO_PASSWORD)
    .start();

  const endpoint = container.getConnectionUrl();

  const client = createStorageClient({
    endpoint,
    region: 'us-east-1',
    bucket: BUCKET_NAME,
    accessKeyId: MINIO_USER,
    secretAccessKey: MINIO_PASSWORD,
  });

  // Create the bucket via the S3 PUT-bucket API before running the test fn.
  const bucketUrl = `${endpoint}/${BUCKET_NAME}`;
  const res = await client.aws.fetch(bucketUrl, { method: 'PUT' });
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    await container.stop();
    throw new Error(`Failed to create MinIO test bucket: HTTP ${res.status} — ${text}`);
  }

  try {
    await fn({ client, bucketName: BUCKET_NAME });
  } finally {
    await container.stop();
  }
}
