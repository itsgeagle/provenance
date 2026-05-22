import { describe, it, expect } from 'vitest';
import { bundleKey, exportKey, ingestStagingKey } from './keys.js';

describe('bundleKey', () => {
  it('returns correct path for a bundle', () => {
    const key = bundleKey('sem-abc', 'sub-xyz');
    expect(key).toBe('semesters/sem-abc/submissions/sub-xyz/bundle.zip');
  });

  it('uses the provided semesterId and submissionId verbatim', () => {
    const key = bundleKey(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(key).toBe(
      'semesters/00000000-0000-0000-0000-000000000001/submissions/00000000-0000-0000-0000-000000000002/bundle.zip',
    );
  });
});

describe('exportKey', () => {
  it('returns correct path for md format', () => {
    expect(exportKey('artifact-1', 'md')).toBe('exports/artifact-1.md');
  });

  it('returns correct path for pdf format', () => {
    expect(exportKey('artifact-2', 'pdf')).toBe('exports/artifact-2.pdf');
  });
});

describe('ingestStagingKey', () => {
  it('returns correct path', () => {
    expect(ingestStagingKey('job-1', 'file-1')).toBe('ingest-staging/job-1/file-1');
  });

  it('separates job and file ids with a slash', () => {
    const key = ingestStagingKey('j', 'f');
    expect(key.startsWith('ingest-staging/')).toBe(true);
    expect(key.split('/').length).toBe(3);
  });
});
