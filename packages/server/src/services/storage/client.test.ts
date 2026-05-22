/**
 * Unit tests for the storage client factory.
 * No network calls — just exercises construction with controlled env values.
 */

import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../config/env.js';
import { storageConfigFromEnv, createStorageClient } from './client.js';

const VALID_BASE: Record<string, string> = {
  NODE_ENV: 'development',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
};

describe('storageConfigFromEnv', () => {
  it('extracts all OBJECT_STORAGE_* fields from a validated env', () => {
    const env = parseEnv(VALID_BASE);
    const cfg = storageConfigFromEnv(env);
    expect(cfg.endpoint).toBe('http://localhost:9000');
    expect(cfg.region).toBe('auto');
    expect(cfg.bucket).toBe('provenance');
    expect(cfg.accessKeyId).toBe('minioadmin');
    expect(cfg.secretAccessKey).toBe('minioadmin');
  });

  it('preserves a custom region from env', () => {
    const env = parseEnv({ ...VALID_BASE, OBJECT_STORAGE_REGION: 'us-east-1' });
    const cfg = storageConfigFromEnv(env);
    expect(cfg.region).toBe('us-east-1');
  });
});

describe('createStorageClient', () => {
  it('builds a bucketUrl by joining endpoint + bucket', () => {
    const env = parseEnv(VALID_BASE);
    const cfg = storageConfigFromEnv(env);
    const client = createStorageClient(cfg);
    expect(client.bucketUrl).toBe('http://localhost:9000/provenance');
  });

  it('strips a trailing slash from endpoint before joining', () => {
    const env = parseEnv({ ...VALID_BASE, OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000/' });
    const cfg = storageConfigFromEnv(env);
    const client = createStorageClient(cfg);
    expect(client.bucketUrl).toBe('http://localhost:9000/provenance');
  });

  it('returns an AwsClient instance', () => {
    const env = parseEnv(VALID_BASE);
    const cfg = storageConfigFromEnv(env);
    const client = createStorageClient(cfg);
    expect(typeof client.aws.fetch).toBe('function');
  });
});
