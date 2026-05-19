import { describe, it, expect } from 'vitest';
import { serializeEntry, parseEntries } from './ndjson.js';
import { chainEntry, GENESIS_PREV_HASH, sha256Hex } from './hash-chain.js';
import type { Envelope, HashedEnvelope } from './envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(seq: number): HashedEnvelope<'session.end'> {
  const env: Envelope<'session.end'> = {
    seq,
    t: seq * 1000,
    wall: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    kind: 'session.end',
    data: { reason: 'test' },
  };
  const prevHash = seq === 0 ? GENESIS_PREV_HASH : sha256Hex(`prev-${seq}`);
  return chainEntry(prevHash, env, sha256Hex);
}

function makeChain(count: number): HashedEnvelope[] {
  const entries: HashedEnvelope[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < count; i++) {
    const env: Envelope<'session.end'> = {
      seq: i,
      t: i * 1000,
      wall: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      kind: 'session.end',
      data: { reason: 'test' },
    };
    const hashed = chainEntry(prevHash, env, sha256Hex);
    entries.push(hashed);
    prevHash = hashed.hash;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// serializeEntry
// ---------------------------------------------------------------------------

describe('serializeEntry', () => {
  it('returns a string ending with a newline', () => {
    const entry = makeEntry(0);
    const line = serializeEntry(entry);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('round-trips through parseEntries — single entry matches original', () => {
    const entry = makeEntry(0);
    const serialized = serializeEntry(entry);
    const result = parseEntries(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toEqual(entry);
  });

  it('round-trips three chained entries', () => {
    const entries = makeChain(3);
    const ndjson = entries.map(serializeEntry).join('');
    const result = parseEntries(ndjson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(result.value[i]).toEqual(entries[i]);
    }
  });

  it('produces JCS canonical JSON (no extra whitespace)', () => {
    const entry = makeEntry(0);
    const line = serializeEntry(entry);
    // Strip the trailing newline — should be valid JSON with no pretty-print whitespace
    const json = line.slice(0, -1);
    expect(json).not.toContain('\n');
    expect(json).not.toMatch(/:\s{2,}/); // no extra spaces after colons
    // Parsing back should give the same object
    expect(JSON.parse(json)).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// parseEntries
// ---------------------------------------------------------------------------

describe('parseEntries', () => {
  it('returns ok with empty array for empty string', () => {
    const result = parseEntries('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('tolerates a trailing newline (skips the empty line it produces)', () => {
    const entry = makeEntry(0);
    // serializeEntry already appends \n, so this is already a trailing-newline scenario
    const result = parseEntries(serializeEntry(entry));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('tolerates multiple trailing newlines', () => {
    const entry = makeEntry(0);
    const serialized = serializeEntry(entry) + '\n\n';
    const result = parseEntries(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('parses multiple entries from concatenated serialized lines', () => {
    const entries = makeChain(3);
    const ndjson = entries.map(serializeEntry).join('');
    const result = parseEntries(ndjson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it('returns invalid_json error on a malformed JSON line, with correct 1-indexed line number', () => {
    const entry = makeEntry(0);
    const goodLine = serializeEntry(entry); // ends with \n
    const badLine = 'this is not json\n';
    const text = goodLine + badLine;
    const result = parseEntries(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_json');
    if (result.error.kind === 'invalid_json') {
      expect(result.error.line).toBe(2); // second line is the bad one
    }
  });

  it('returns invalid_json on first line if immediately malformed', () => {
    const result = parseEntries('not-json\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_json');
    if (result.error.kind === 'invalid_json') {
      expect(result.error.line).toBe(1);
    }
  });

  it('returns invalid_shape when hash field is missing', () => {
    const entry = makeEntry(0);
    // Build a line that is valid JSON but missing the `hash` field
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hash: _hash, ...noHash } = entry;
    const line = JSON.stringify(noHash) + '\n';
    const result = parseEntries(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
    if (result.error.kind === 'invalid_shape') {
      expect(result.error.missing_field).toBe('hash');
    }
  });

  it('returns invalid_shape when prev_hash field is missing', () => {
    const entry = makeEntry(0);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { prev_hash: _prev, ...noPrev } = entry;
    const line = JSON.stringify(noPrev) + '\n';
    const result = parseEntries(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
  });

  it('returns invalid_shape when seq field is missing', () => {
    const entry = makeEntry(0);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { seq: _seq, ...noSeq } = entry;
    const line = JSON.stringify(noSeq) + '\n';
    const result = parseEntries(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
    if (result.error.kind === 'invalid_shape') {
      expect(result.error.missing_field).toBe('seq');
    }
  });

  it('accepts entries with unknown kind values (forward-compat per PRD §5.1)', () => {
    const entry = makeEntry(0);
    // Replace the known kind with an unknown one, but keep valid hashes
    // Since we're testing that unknown kinds are not rejected at parse time,
    // we need a valid-shaped object. We just change the kind string.
    const withUnknownKind = { ...entry, kind: 'future.unknown_event' };
    const line = JSON.stringify(withUnknownKind) + '\n';
    const result = parseEntries(line);
    // Should succeed — unknown kinds are accepted at the NDJSON parse layer
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.kind).toBe('future.unknown_event');
  });

  it('returns invalid_shape when hash is wrong length (not 64 hex chars)', () => {
    const entry = makeEntry(0);
    const withBadHash = { ...entry, hash: 'tooshort' };
    const line = JSON.stringify(withBadHash) + '\n';
    const result = parseEntries(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
  });

  it('returns invalid_shape when data field is not an object', () => {
    const entry = makeEntry(0);
    const withBadData = { ...entry, data: 'not-an-object' };
    const line = JSON.stringify(withBadData) + '\n';
    const result = parseEntries(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
    if (result.error.kind === 'invalid_shape') {
      expect(result.error.missing_field).toBe('data');
    }
  });
});
