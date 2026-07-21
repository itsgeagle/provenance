/**
 * Tests for recoverPreviousSession.
 *
 * Branch table:
 * 1. Empty directory → clean_start.
 * 2. Valid chain + session.end (complete) → previous_session_complete.
 * 3. Valid chain + no session.end (dangling) → previous_session_dangling.
 * 4. Parse error (bad JSON) → quarantined + previous_session_corrupt.
 * 5. Chain validation failure → quarantined + previous_session_corrupt.
 * 6. Read error (e.g., permission denied) → quarantined + previous_session_corrupt.
 * 7. Multiple .slog files → the one with the latest session.start wall wins,
 *    regardless of filename order (filenames are UUIDv4 and carry no ordering).
 */

import { describe, it, expect } from 'vitest';
import { chainEntry, GENESIS_PREV_HASH, serializeEntry, sha256Hex } from '@provenance/log-core';
import type { Envelope } from '@provenance/log-core';
import { recoverPreviousSession } from './chain-recovery.js';
import type { RecoveryDeps } from './chain-recovery.js';

// ---------------------------------------------------------------------------
// Helpers to build valid .slog content
// ---------------------------------------------------------------------------

const FAKE_SESSION_ID = '00000000-0000-0000-0000-000000000001';

function makeStartEnvelope(
  sessionId: string = FAKE_SESSION_ID,
  wall = '2026-01-01T00:00:00.000Z',
): Envelope<'session.start'> {
  return {
    seq: 0,
    t: 0,
    wall,
    kind: 'session.start',
    data: {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: null,
      assignment: { id: 'hw03', semester: 'fa26' },
      manifest_sig: 'a'.repeat(128),
      machine_id: 'b'.repeat(64),
      vscode: { version: '1.97.0', commit: '', platform: 'darwin-arm64' },
      recorder: { version: '0.0.0', extension_id: 'test.recorder' },
      session_pubkey: '',
    },
  };
}

function makeEndEnvelope(seq: number): Envelope<'session.end'> {
  return {
    seq,
    t: 100,
    wall: '2026-01-01T00:00:01.000Z',
    kind: 'session.end',
    data: { reason: 'deactivate' },
  };
}

function buildCompleteSlog(sessionId: string = FAKE_SESSION_ID, startWall?: string): string {
  const startEnv = makeStartEnvelope(sessionId, startWall);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);

  const endEnv = makeEndEnvelope(1);
  const endEntry = chainEntry(startEntry.hash, endEnv, sha256Hex);

  return serializeEntry(startEntry) + serializeEntry(endEntry);
}

function buildDanglingSlog(sessionId: string = FAKE_SESSION_ID, startWall?: string): string {
  const startEnv = makeStartEnvelope(sessionId, startWall);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);
  return serializeEntry(startEntry);
}

// ---------------------------------------------------------------------------
// Build deps
// ---------------------------------------------------------------------------

function makeDeps(files: Record<string, string>, opts: Partial<RecoveryDeps> = {}): RecoveryDeps {
  const fixedNow = new Date('2026-01-02T00:00:00.000Z');
  const renamedFiles: Array<{ from: string; to: string }> = [];

  return {
    provenanceDir: '/fake/.provenance',
    listSlogFiles: async (dir) => {
      void dir;
      return Object.keys(files).filter((f) => f.endsWith('.slog'));
    },
    readSlogFile: async (filePath) => {
      const filename = filePath.split('/').pop() ?? filePath;
      const content = files[filename];
      if (content === undefined) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, text: content };
    },
    rename: async (from, to) => {
      renamedFiles.push({ from, to });
      // Remove the file from the in-memory map so it looks moved.
      const filename = from.split('/').pop() ?? from;
      delete files[filename];
    },
    now: () => fixedNow,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverPreviousSession', () => {
  it('returns clean_start when no .slog files exist', async () => {
    const deps = makeDeps({});
    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('clean_start');
  });

  it('returns previous_session_complete for a valid chain ending with session.end', async () => {
    const slogContent = buildCompleteSlog();
    const deps = makeDeps({ 'session-abc.slog': slogContent });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_complete');
    if (result.kind !== 'previous_session_complete') return;
    expect(result.prevSessionId).toBe(FAKE_SESSION_ID);
  });

  it('returns previous_session_dangling for a valid chain with no session.end', async () => {
    const slogContent = buildDanglingSlog();
    const deps = makeDeps({ 'session-abc.slog': slogContent });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe(FAKE_SESSION_ID);
    expect(result.danglingPath).toContain('session-abc.slog');
  });

  it('returns previous_session_corrupt and quarantines file on invalid JSON', async () => {
    const deps = makeDeps({ 'session-bad.slog': 'NOT VALID JSON\n' });

    let renamedFrom = '';
    let renamedTo = '';
    const origRename = deps.rename;
    deps.rename = async (from, to) => {
      renamedFrom = from;
      renamedTo = to;
      await origRename(from, to);
    };

    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_corrupt');
    if (result.kind !== 'previous_session_corrupt') return;
    expect(result.quarantinedPath).toContain('.corrupt-');
    expect(renamedFrom).toContain('session-bad.slog');
    expect(renamedTo).toContain('.corrupt-');
  });

  it('returns previous_session_corrupt and quarantines file on broken chain', async () => {
    // Build a dangling slog then corrupt its content.
    const valid = buildDanglingSlog();
    const lines = valid.split('\n').filter((l) => l.length > 0);
    // Tamper with the first line by changing a hash byte.
    const tampered = lines[0]!.replace(/"hash":"[0-9a-f]/, '"hash":"z') + '\n';

    const deps = makeDeps({ 'session-tampered.slog': tampered });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_corrupt');
  });

  it('returns previous_session_corrupt and quarantines file on read error', async () => {
    const deps = makeDeps({ 'session-err.slog': '' });
    // Override readSlogFile to return a read_error.
    deps.readSlogFile = async () => ({ ok: false, reason: 'read_error' });

    let renamedCalled = false;
    deps.rename = async () => {
      renamedCalled = true;
    };

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    expect(renamedCalled).toBe(true);
  });

  it('picks the .slog with the latest session.start wall, not the alphabetically last', async () => {
    // session-aaa started later than session-zzz. Filenames are UUIDv4-derived
    // and carry no ordering information, so alphabetical order must lose.
    const slogRecent = buildDanglingSlog('recent-session-id', '2026-01-01T05:00:00.000Z');
    const slogOlder = buildCompleteSlog('older-session-id', '2026-01-01T00:00:00.000Z');

    const deps = makeDeps({
      'session-aaa.slog': slogRecent,
      'session-zzz.slog': slogOlder, // alphabetically last, but older
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('recent-session-id');
    expect(result.danglingPath).toContain('session-aaa.slog');
  });

  it('picks the most recent session across more than two .slog files', async () => {
    // Regression for the observed real-world failure: several sessions in one
    // provenanceDir all reported the same prev_session_id because one filename
    // kept sorting last. The middle session here is the newest.
    const deps = makeDeps({
      'session-ddd.slog': buildCompleteSlog('oldest', '2026-01-01T00:00:00.000Z'),
      'session-bbb.slog': buildDanglingSlog('newest', '2026-01-01T09:00:00.000Z'),
      'session-ccc.slog': buildCompleteSlog('middle', '2026-01-01T04:00:00.000Z'),
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('newest');
  });

  it('falls back to the alphabetically last .slog when none has a parseable session.start', async () => {
    // Both unusable → the fallback still runs the quarantine path.
    const deps = makeDeps({
      'session-aaa.slog': 'NOT VALID JSON\n',
      'session-zzz.slog': 'ALSO NOT VALID\n',
    });

    let renamedFrom = '';
    deps.rename = async (from) => {
      renamedFrom = from;
    };

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    expect(renamedFrom).toContain('session-zzz.slog');
  });

  it('ignores an unreadable .slog when a readable, older one exists', async () => {
    const deps = makeDeps({
      'session-aaa.slog': buildCompleteSlog('readable', '2026-01-01T00:00:00.000Z'),
      'session-zzz.slog': 'NOT VALID JSON\n',
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_complete');
    if (result.kind !== 'previous_session_complete') return;
    expect(result.prevSessionId).toBe('readable');
  });

  it('quarantine path includes ISO timestamp', async () => {
    const deps = makeDeps({ 'session-bad.slog': 'bad json\n' });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    if (result.kind !== 'previous_session_corrupt') return;
    // ISO timestamp in quarantine filename (colons/dots replaced with dashes)
    expect(result.quarantinedPath).toContain('2026-01-02');
  });
});
