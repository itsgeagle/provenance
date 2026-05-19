/**
 * Test-only helper: builds a self-consistent bundle ZIP in memory.
 *
 * This is test infrastructure; it does not need to be browser-safe (vitest runs
 * it under jsdom which has crypto.getRandomValues). No Node-specific APIs are
 * used — just @noble/ed25519, log-core, and jszip.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import JSZip from 'jszip';
import {
  chainEntry,
  sha256Hex,
  canonicalize,
  serializeEntry,
  GENESIS_PREV_HASH,
} from '@provenance/log-core';
import type { BundleManifest, SlogMeta } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Wire SHA-512 into @noble/ed25519 so it works in jsdom where SubtleCrypto
// does not accept SharedArrayBuffer from concatBytes as the 2nd argument to
// digest(). Use @noble/hashes/sha2 (pure JS, no WebCrypto) for both paths.
// The docs-recommended pattern: set ed.hashes.sha512 = sha512.
// ---------------------------------------------------------------------------
ed.hashes.sha512 = sha512;
// Override sha512Async too: the default implementation calls SubtleCrypto.digest
// with `m.buffer` which may be a SharedArrayBuffer, rejected by jsdom's WebCrypto.
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BuildBundleOpts = {
  assignmentId?: string;
  semester?: string;
  sessions?: Array<{
    /** Defaults to a deterministic UUID based on session index. */
    sessionId?: string;
    /** Additional events after session.start; defaults to 5. */
    eventCount?: number;
    /** Optional explicit wall timestamps for events (starting from session.start). */
    walls?: string[];
  }>;
  tamper?: {
    omitManifest?: boolean;
    omitSig?: boolean;
    omitAllSlogs?: boolean;
    /** Omit one session's .slog.meta — produces orphaned_slog error. */
    omitOneSlogMeta?: boolean;
    /** Omit one session's .slog (while keeping its .meta) — produces orphaned_meta error. */
    omitOneSlog?: boolean;
    addStrayFile?: { name: string; content: string };
    corruptNdjsonAtLine?: { sessionIndex: number; line: number };
  };
};

export type BuiltBundle = {
  blob: Blob;
  /** Raw ArrayBuffer of the ZIP — use this when blob.arrayBuffer() is unavailable. */
  zipBuffer: ArrayBuffer;
  manifest: BundleManifest;
  /** Hex-encoded ed25519 private key used to sign the manifest. */
  sessionPrivkeyHex: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID-shaped string for a given index. */
function fakeUuid(index: number): string {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

/** ISO timestamp offset from a base epoch for deterministic walls. */
function wallAt(sessionIndex: number, eventIndex: number): string {
  // Base: 2026-01-01T00:00:00.000Z plus (session * 1 hour) + (event * 10 seconds)
  const baseMs = 1767225600000; // 2026-01-01T00:00:00.000Z
  const ms = baseMs + sessionIndex * 3_600_000 + eventIndex * 10_000;
  return new Date(ms).toISOString();
}

/**
 * Build a self-consistent slog (NDJSON text) and meta (JSON text) for one session.
 */
async function buildSession(opts: {
  sessionId: string;
  sessionIndex: number;
  pubkeyHex: string;
  eventCount: number;
  walls?: string[];
  assignmentId: string;
  semester: string;
}): Promise<{ slogText: string; metaJson: string }> {
  const { sessionId, sessionIndex, pubkeyHex, eventCount, walls, assignmentId, semester } = opts;

  const lines: string[] = [];
  let prevHash = GENESIS_PREV_HASH;

  // session.start (seq 0)
  const startEnvelope = {
    seq: 0,
    t: 0,
    wall: walls?.[0] ?? wallAt(sessionIndex, 0),
    kind: 'session.start' as const,
    data: {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: null as string | null,
      assignment: { id: assignmentId, semester },
      manifest_sig: 'placeholder-sig',
      machine_id: 'test-machine',
      vscode: { version: '1.90.0', commit: '', platform: 'darwin' },
      recorder: { version: '0.0.1', extension_id: 'provenance.recorder' },
      session_pubkey: pubkeyHex,
    },
  };

  const startEntry = chainEntry(prevHash, startEnvelope);
  lines.push(serializeEntry(startEntry).trimEnd());
  prevHash = startEntry.hash;

  // Additional synthetic doc.change events
  for (let i = 1; i <= eventCount; i++) {
    const changeEnvelope = {
      seq: i,
      t: i * 1000,
      wall: walls?.[i] ?? wallAt(sessionIndex, i),
      kind: 'doc.change' as const,
      data: {
        path: '/test/file.py',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: `x${i}`,
          },
        ],
        source: 'typed' as const,
      },
    };

    const entry = chainEntry(prevHash, changeEnvelope);
    lines.push(serializeEntry(entry).trimEnd());
    prevHash = entry.hash;
  }

  const slogText = lines.join('\n') + '\n';

  // .slog.meta
  const meta: SlogMeta = {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: pubkeyHex,
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'ab'.repeat(12), // 24 hex chars = 12 bytes
      ciphertext: 'cd'.repeat(48), // 96 hex chars = placeholder ciphertext
      salt: 'ef'.repeat(16), // 32 hex chars = 16 bytes
      info: 'provenance-session-v1',
    },
    checkpoints: [],
  };

  const metaJson = JSON.stringify(meta);
  return { slogText, metaJson };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildTestBundle(opts?: BuildBundleOpts): Promise<BuiltBundle> {
  const assignmentId = opts?.assignmentId ?? 'hw1';
  const semester = opts?.semester ?? 'sp26';
  const sessionSpecs = opts?.sessions ?? [{}];
  const tamper = opts?.tamper ?? {};

  // Generate one keypair shared across sessions (manifest sig is all that matters here).
  const privkey = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(privkey);
  const pubkeyHex = bytesToHex(pubkey);
  const sessionPrivkeyHex = bytesToHex(privkey);

  // ---------------------------------------------------------------------------
  // 1. Build each session's slog + meta.
  // ---------------------------------------------------------------------------
  type SessionData = {
    sessionId: string;
    slogText: string;
    metaJson: string;
    slogSha256: string;
    metaSha256: string;
  };

  const sessions: SessionData[] = [];
  for (let i = 0; i < sessionSpecs.length; i++) {
    const spec = sessionSpecs[i]!;
    const sessionId = spec.sessionId ?? fakeUuid(i);
    const eventCount = spec.eventCount ?? 5;
    const walls = spec.walls;

    const { slogText, metaJson } = await buildSession({
      sessionId,
      sessionIndex: i,
      pubkeyHex,
      eventCount,
      ...(walls !== undefined ? { walls } : {}),
      assignmentId,
      semester,
    });

    sessions.push({
      sessionId,
      slogText,
      metaJson,
      slogSha256: sha256Hex(slogText),
      metaSha256: sha256Hex(metaJson),
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Apply corruptNdjsonAtLine tamper (before manifest sha256 computation).
  // ---------------------------------------------------------------------------
  if (tamper.corruptNdjsonAtLine !== undefined) {
    const { sessionIndex, line } = tamper.corruptNdjsonAtLine;
    const session = sessions[sessionIndex];
    if (session !== undefined) {
      const slogLines = session.slogText.split('\n');
      const targetLine = line - 1; // 0-indexed
      if (slogLines[targetLine] !== undefined) {
        slogLines[targetLine] = 'NOT VALID JSON {{{';
      }
      session.slogText = slogLines.join('\n');
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Build BundleManifest.
  // ---------------------------------------------------------------------------
  const manifest: BundleManifest = {
    format_version: '1.0',
    assignment_id: assignmentId,
    semester,
    extension_hash: 'a'.repeat(64),
    sessions: sessions.map((s) => ({
      session_id: s.sessionId,
      prev_session_id: null,
      slog_sha256: s.slogSha256,
      meta_sha256: s.metaSha256,
    })),
  };

  // ---------------------------------------------------------------------------
  // 4. Sign manifest.
  // ---------------------------------------------------------------------------
  const canonicalManifest = canonicalize(manifest);
  const canonicalBytes = new TextEncoder().encode(canonicalManifest);
  const sigBytes = await ed.signAsync(canonicalBytes, privkey);
  const sigHex = bytesToHex(sigBytes);

  // ---------------------------------------------------------------------------
  // 5. Build ZIP, applying tamper mutations.
  // ---------------------------------------------------------------------------
  const zip = new JSZip();

  if (!tamper.omitManifest) {
    zip.file('manifest.json', canonicalManifest);
  }
  if (!tamper.omitSig) {
    zip.file('manifest.sig', sigHex);
  }

  if (!tamper.omitAllSlogs) {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const slogName = `session-${s.sessionId}.slog`;
      const metaName = `session-${s.sessionId}.slog.meta`;

      const isLastSession = i === sessions.length - 1;

      // omitOneSlogMeta: omit meta for the last session → orphaned_slog error.
      const skipMeta = tamper.omitOneSlogMeta === true && isLastSession;
      // omitOneSlog: omit slog for the last session but keep its meta → orphaned_meta error.
      const skipSlog = tamper.omitOneSlog === true && isLastSession;

      if (!skipSlog) {
        zip.file(slogName, s.slogText);
      }
      if (!skipMeta) {
        zip.file(metaName, s.metaJson);
      }
    }
  }

  if (tamper.addStrayFile !== undefined) {
    zip.file(tamper.addStrayFile.name, tamper.addStrayFile.content);
  }

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  const blob = new Blob([zipBuffer], { type: 'application/zip' });

  return { blob, zipBuffer, manifest, sessionPrivkeyHex };
}
