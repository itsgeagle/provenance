/**
 * Schema validation tests for heuristic config JSON files (Phase 17).
 *
 * These tests verify that the committed JSON files have the expected structure
 * and values. They serve as a guard against accidental editing of the files and
 * as documentation of the contract each JSON must satisfy.
 */

import { describe, it, expect } from 'vitest';
import aiExtensionList from './ai-extension-list.json';
import knownGoodHashes from './known-good-extension-hashes.json';

// ---------------------------------------------------------------------------
// ai-extension-list.json
// ---------------------------------------------------------------------------

describe('ai-extension-list.json — schema', () => {
  it('has an extensionIds field that is an array', () => {
    expect(Array.isArray(aiExtensionList.extensionIds)).toBe(true);
  });

  it('extensionIds is non-empty (course-maintained list must have at least one entry)', () => {
    expect(aiExtensionList.extensionIds.length).toBeGreaterThan(0);
  });

  it('all extension IDs are non-empty strings', () => {
    for (const id of aiExtensionList.extensionIds) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('all extension IDs contain a dot (publisher.name format)', () => {
    for (const id of aiExtensionList.extensionIds) {
      expect(id).toContain('.');
    }
  });

  it('contains the major known AI coding tools', () => {
    const ids = aiExtensionList.extensionIds;
    expect(ids).toContain('GitHub.copilot');
    expect(ids).toContain('Codeium.codeium');
    expect(ids).toContain('Continue.continue');
    expect(ids).toContain('TabNine.tabnine-vscode');
  });

  it('extension IDs are unique (no duplicates)', () => {
    const ids = aiExtensionList.extensionIds;
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// known-good-extension-hashes.json
// ---------------------------------------------------------------------------

describe('known-good-extension-hashes.json — schema', () => {
  it('has a hashes field that is an array', () => {
    expect(Array.isArray(knownGoodHashes.hashes)).toBe(true);
  });

  it('hashes array is non-empty (ships with at least the placeholder)', () => {
    expect(knownGoodHashes.hashes.length).toBeGreaterThan(0);
  });

  it('all hash entries are non-empty strings', () => {
    for (const h of knownGoodHashes.hashes) {
      expect(typeof h).toBe('string');
      expect(h.length).toBeGreaterThan(0);
    }
  });

  it('has a description field explaining the purpose', () => {
    expect(typeof (knownGoodHashes as Record<string, unknown>)['description']).toBe('string');
  });
});
