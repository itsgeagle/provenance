import { describe, it, expect } from 'vitest';
import { validateMetaShape } from './meta.js';

// ---------------------------------------------------------------------------
// Helper: build a valid SlogMeta-shaped object
// ---------------------------------------------------------------------------

function validMeta(): Record<string, unknown> {
  return {
    format_version: '1.0',
    session_id: 'test-session-id',
    session_pubkey: 'a'.repeat(64),
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'deadbeef',
      ciphertext: 'cafecafe',
      salt: '12345678',
      info: 'provenance-session-key-v1',
    },
    checkpoints: [
      {
        seq: 0,
        hash: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateMetaShape', () => {
  it('accepts a valid meta object', () => {
    const result = validateMetaShape(validMeta());
    expect(result.ok).toBe(true);
  });

  it('accepts a valid meta with no checkpoints (empty array)', () => {
    const meta = { ...validMeta(), checkpoints: [] };
    expect(validateMetaShape(meta).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'string', 42, [], true]) {
      const result = validateMetaShape(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('not_object');
      }
    }
  });

  it('rejects wrong format_version', () => {
    const meta = { ...validMeta(), format_version: '2.0' };
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('wrong_version');
      if (result.error.kind === 'wrong_version') {
        expect(result.error.actual).toBe('2.0');
      }
    }
  });

  it('rejects missing session_id', () => {
    const meta = validMeta();
    delete meta['session_id'];
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('missing_field');
      if (result.error.kind === 'missing_field') {
        expect(result.error.field).toBe('session_id');
      }
    }
  });

  it('rejects missing session_pubkey', () => {
    const meta = validMeta();
    delete meta['session_pubkey'];
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be missing_field or invalid_field depending on impl
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects session_pubkey with wrong length', () => {
    const meta = { ...validMeta(), session_pubkey: 'a'.repeat(63) };
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
      if (result.error.kind === 'invalid_field') {
        expect(result.error.field).toBe('session_pubkey');
      }
    }
  });

  it('rejects session_pubkey with non-hex characters', () => {
    const meta = { ...validMeta(), session_pubkey: 'z'.repeat(64) };
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('rejects missing encrypted_session_privkey', () => {
    const meta = validMeta();
    delete meta['encrypted_session_privkey'];
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects wrong algorithm in encrypted_session_privkey', () => {
    const meta = validMeta();
    (meta['encrypted_session_privkey'] as Record<string, unknown>)['algorithm'] = 'aes-gcm';
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('rejects empty nonce in encrypted_session_privkey', () => {
    const meta = validMeta();
    (meta['encrypted_session_privkey'] as Record<string, unknown>)['nonce'] = '';
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('rejects non-hex nonce in encrypted_session_privkey', () => {
    const meta = validMeta();
    (meta['encrypted_session_privkey'] as Record<string, unknown>)['nonce'] = 'xyz';
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
  });

  it('rejects missing checkpoints', () => {
    const meta = validMeta();
    delete meta['checkpoints'];
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects checkpoint with bad hash (not 64 hex chars)', () => {
    const meta = validMeta();
    (meta['checkpoints'] as unknown[])[0] = {
      seq: 0,
      hash: 'tooshort',
      sig: 'c'.repeat(128),
    };
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('rejects checkpoint with bad sig (not 128 hex chars)', () => {
    const meta = validMeta();
    (meta['checkpoints'] as unknown[])[0] = {
      seq: 0,
      hash: 'b'.repeat(64),
      sig: 'tooshort',
    };
    const result = validateMetaShape(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });
});
