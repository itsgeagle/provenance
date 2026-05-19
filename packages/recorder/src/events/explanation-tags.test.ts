/**
 * Tests for explanation-tags.ts
 * PRD §4.5: explanation tags for formatter/git external changes.
 */

import { describe, expect, it } from 'vitest';
import { ExplanationTagger } from './explanation-tags.js';

describe('ExplanationTagger', () => {
  it('consume() with no marks returns undefined', () => {
    const tagger = new ExplanationTagger({ getNow: () => 0 });
    expect(tagger.consume()).toBeUndefined();
  });

  it('markFormatter() then consume() within window returns "formatter"', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 500; // 500ms later — within 2000ms window

    expect(tagger.consume()).toBe('formatter');
  });

  it('consuming clears the tag — second consume returns undefined', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 100;
    expect(tagger.consume()).toBe('formatter');

    now = 200;
    expect(tagger.consume()).toBeUndefined();
  });

  it('markGit() then consume() AFTER window returns undefined', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 2001; // past the 2000ms window

    expect(tagger.consume()).toBeUndefined();
  });

  it('markGit() then consume() exactly at window boundary (equal) returns undefined', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 2000; // elapsed === windowMs; condition is > so this is NOT within window

    expect(tagger.consume()).toBeUndefined();
  });

  it('markGit() then consume() within window returns "git"', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 1999;

    expect(tagger.consume()).toBe('git');
  });

  it('multiple marks: most recent tag wins', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 100;
    tagger.markGit(); // overwrites the formatter tag

    now = 200;
    expect(tagger.consume()).toBe('git');
  });

  it('default windowMs is 2000ms', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now }); // no windowMs

    tagger.markFormatter();
    now = 1999;
    expect(tagger.consume()).toBe('formatter');
  });

  it('expired tag does not prevent future marks from working', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 3000; // expired
    tagger.consume(); // clears it

    // New mark — should work fine
    tagger.markGit();
    now = 3500;
    expect(tagger.consume()).toBe('git');
  });
});
