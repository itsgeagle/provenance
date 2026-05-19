import { describe, it, expect } from 'vitest';
import { chainEntry, sha256Hex, GENESIS_PREV_HASH } from './hash-chain.js';
import { canonicalize } from './canonical.js';
import type { Envelope } from './envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionEndOverrides = Partial<Omit<Envelope<'session.end'>, 'kind'>>;

function makeEnvelope(seq: number, overrides: SessionEndOverrides = {}): Envelope<'session.end'> {
  return {
    seq,
    t: seq * 1000,
    wall: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    kind: 'session.end',
    data: { reason: 'test' },
    ...overrides,
  };
}

// A trivial deterministic fake hash function for predictable test assertions.
const fakeHashFn = (input: string | Uint8Array): string => {
  const s = typeof input === 'string' ? input : new TextDecoder().decode(input);
  // Pad/truncate to 64 chars so it looks like a hex hash.
  return s.slice(0, 64).padEnd(64, '0');
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chainEntry', () => {
  it('produces a deterministic hash for the genesis entry across two calls', () => {
    const entry = makeEnvelope(0);
    const r1 = chainEntry(GENESIS_PREV_HASH, entry);
    const r2 = chainEntry(GENESIS_PREV_HASH, entry);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash).toHaveLength(64);
  });

  it('sets prev_hash to the provided prevHash', () => {
    const entry = makeEnvelope(0);
    const result = chainEntry(GENESIS_PREV_HASH, entry);
    expect(result.prev_hash).toBe(GENESIS_PREV_HASH);
  });

  it('chains two entries so that entry1.prev_hash === entry0.hash', () => {
    const e0 = makeEnvelope(0);
    const e1 = makeEnvelope(1);
    const h0 = chainEntry(GENESIS_PREV_HASH, e0);
    const h1 = chainEntry(h0.hash, e1);
    expect(h1.prev_hash).toBe(h0.hash);
    expect(h1.hash).toHaveLength(64);
    expect(h1.hash).not.toBe(h0.hash);
  });

  it('honors an injected hashFn — hash equals what the fake fn would compute', () => {
    const entry = makeEnvelope(0);
    const result = chainEntry(GENESIS_PREV_HASH, entry, fakeHashFn);
    const expectedInput = GENESIS_PREV_HASH + canonicalize(entry);
    const expectedHash = fakeHashFn(expectedInput);
    expect(result.hash).toBe(expectedHash);
  });

  it('different `data` produces a different hash', () => {
    const e1 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { data: { reason: 'a' } }));
    const e2 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { data: { reason: 'b' } }));
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('different `t` produces a different hash', () => {
    const e1 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { t: 0 }));
    const e2 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { t: 1 }));
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('different `wall` produces a different hash', () => {
    const e1 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { wall: '2026-01-01T00:00:00.000Z' }));
    const e2 = chainEntry(GENESIS_PREV_HASH, makeEnvelope(0, { wall: '2026-01-01T00:00:01.000Z' }));
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('different `kind` produces a different hash', () => {
    const base = { seq: 0, t: 0, wall: '2026-01-01T00:00:00.000Z' };
    const e1 = chainEntry(GENESIS_PREV_HASH, {
      ...base,
      kind: 'session.end' as const,
      data: { reason: 'x' },
    });
    const e2 = chainEntry(GENESIS_PREV_HASH, {
      ...base,
      kind: 'session.heartbeat' as const,
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    });
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('GENESIS_PREV_HASH is sixty-four zero characters', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
  });

  it('sha256Hex returns a 64-character lowercase hex string', () => {
    const result = sha256Hex('hello world');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('sha256Hex("hello world") matches NIST test vector', () => {
    const result = sha256Hex('hello world');
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('sha256Hex("") matches NIST test vector for empty string', () => {
    const result = sha256Hex('');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('chainEntry produces pinned hash for well-specified envelope', () => {
    const env: Envelope<'session.end'> = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.end',
      data: { reason: 'test' },
    };
    const result = chainEntry(GENESIS_PREV_HASH, env, sha256Hex);

    // Compute the expected hash inline to guard against silent formula changes
    const expected = sha256Hex(GENESIS_PREV_HASH + canonicalize(env));
    expect(result.hash).toBe(expected);

    // Pin the hard-coded value derived from running the actual code
    expect(result.hash).toBe('d33cad1d38b90b26a2f7b1181801805233bf4332eca5bc6d4ff4e1b677683625');
  });
});
