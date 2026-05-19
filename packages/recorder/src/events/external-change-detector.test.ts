/**
 * Tests for external-change-detector.ts
 * PRD §4.5: on-disk hash comparison.
 */

import { describe, expect, it } from 'vitest';
import { compareSavedContent } from './external-change-detector.js';
import { ExpectedContent } from '../state/expected-content.js';
import { sha256Hex } from '@provenance/log-core';

describe('compareSavedContent', () => {
  it('returns clean_save when on-disk content matches expected', () => {
    const content = 'def foo():\n    return 42\n';
    const ec = new ExpectedContent(content);
    const result = compareSavedContent(ec, content);

    expect(result.kind).toBe('clean_save');
    if (result.kind === 'clean_save') {
      expect(result.new_hash).toBe(sha256Hex(content));
    }
  });

  it('returns external_change when on-disk content differs', () => {
    const original = 'def foo():\n    return 42\n';
    const modified = 'def foo():\n    return 9999\n';
    const ec = new ExpectedContent(original);
    const result = compareSavedContent(ec, modified);

    expect(result.kind).toBe('external_change');
    if (result.kind === 'external_change') {
      expect(result.old_hash).toBe(sha256Hex(original));
      expect(result.new_hash).toBe(sha256Hex(modified));
      // diff_size = |modified.length - original.length|
      expect(result.diff_size).toBe(Math.abs(modified.length - original.length));
    }
  });

  it('external_change diff_size is |new_length - old_length|', () => {
    const original = 'short';
    const modified = 'much longer string here';
    const ec = new ExpectedContent(original);
    const result = compareSavedContent(ec, modified);

    expect(result.kind).toBe('external_change');
    if (result.kind === 'external_change') {
      expect(result.diff_size).toBe(Math.abs(modified.length - original.length));
    }
  });

  it('external_change: diff_size is 0 when same-length but different bytes', () => {
    // Same length, different content — diff_size approximation is 0 here.
    // This is a documented limitation of the approximation.
    const original = 'aaaa';
    const modified = 'bbbb';
    const ec = new ExpectedContent(original);
    const result = compareSavedContent(ec, modified);

    expect(result.kind).toBe('external_change');
    if (result.kind === 'external_change') {
      expect(result.diff_size).toBe(0);
    }
  });

  it('does NOT mutate the ExpectedContent instance', () => {
    const content = 'original';
    const modified = 'completely different content here';
    const ec = new ExpectedContent(content);
    const hashBefore = ec.hash;
    const contentBefore = ec.content;

    compareSavedContent(ec, modified);

    // Expected content should be unchanged after the call
    expect(ec.hash).toBe(hashBefore);
    expect(ec.content).toBe(contentBefore);
  });

  it('returns correct hashes for empty file', () => {
    const ec = new ExpectedContent('');
    const result = compareSavedContent(ec, '');

    expect(result.kind).toBe('clean_save');
    if (result.kind === 'clean_save') {
      expect(result.new_hash).toBe(sha256Hex(''));
    }
  });

  it('detects whole-file replacement with large diff_size', () => {
    const original = 'a'.repeat(100);
    const modified = 'b'.repeat(500);
    const ec = new ExpectedContent(original);
    const result = compareSavedContent(ec, modified);

    expect(result.kind).toBe('external_change');
    if (result.kind === 'external_change') {
      expect(result.diff_size).toBe(400); // |500 - 100|
    }
  });
});
