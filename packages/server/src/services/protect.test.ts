import { describe, it, expect } from 'vitest';
import {
  projectStudent,
  maskEmail,
  maskExtras,
  maskFilename,
  protectedLabel,
  protectedSid,
} from './protect.js';

const ID = '11111111-2222-3333-4444-555555555555';

describe('protectedLabel / protectedSid', () => {
  it('uses the index when present', () => {
    expect(protectedLabel(42, ID)).toBe('Student 42');
    expect(protectedSid(42, ID)).toBe('S42');
  });
  it('falls back to a name-independent UUID-derived label when index is null', () => {
    expect(protectedLabel(null, ID)).toBe('Student 111111');
    expect(protectedSid(null, ID)).toBe('S-111111');
  });
});

describe('projectStudent', () => {
  const raw = { id: ID, sid: 'abc123', display_name: 'Alice Zhao', protected_index: 7 };
  it('passes identity through when not protected', () => {
    expect(projectStudent(raw, false)).toEqual({
      id: ID,
      sid: 'abc123',
      display_name: 'Alice Zhao',
    });
  });
  it('masks identity when protected', () => {
    expect(projectStudent(raw, true)).toEqual({ id: ID, sid: 'S7', display_name: 'Student 7' });
  });
});

describe('maskEmail / maskExtras / maskFilename', () => {
  it('nulls email and extras when protected', () => {
    expect(maskEmail('a@b.com', true)).toBeNull();
    expect(maskEmail('a@b.com', false)).toBe('a@b.com');
    expect(maskExtras({ section: '1' }, true)).toBeNull();
    expect(maskExtras({ section: '1' }, false)).toEqual({ section: '1' });
  });
  it('replaces a filename with the supplied label when protected', () => {
    expect(maskFilename('chan_alice_lab03.zip', true, 'Student 7 — lab03')).toBe(
      'Student 7 — lab03',
    );
    expect(maskFilename('chan_alice_lab03.zip', false, 'Student 7 — lab03')).toBe(
      'chan_alice_lab03.zip',
    );
  });
});
