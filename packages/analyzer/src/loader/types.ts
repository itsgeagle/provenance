/**
 * Types for the bundle loader (Phase 1).
 *
 * PRD §5.1, §5.3, §4.6.
 *
 * Naming note: log-core's ndjson.ts also exports a `ParseError` type (for
 * line-level JSON parse failures). The type exported here is the *loader-level*
 * parse error union and is intentionally named `SessionParseError` to avoid
 * shadowing the log-core import in parse-session.ts.
 */

import type {
  HashedEnvelope,
  SlogMeta,
  BundleManifest,
  SessionStartPayload,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Loader errors (unzip / structural)
// ---------------------------------------------------------------------------

export type LoaderError =
  | { kind: 'not_a_zip'; detail?: string }
  | { kind: 'missing_manifest' }
  | { kind: 'missing_signature' }
  | { kind: 'no_sessions' }
  | { kind: 'orphaned_meta'; sessionId: string }
  | { kind: 'orphaned_slog'; sessionId: string }
  | { kind: 'unexpected_file'; filename: string; detail?: string };

// ---------------------------------------------------------------------------
// Session parse errors
// ---------------------------------------------------------------------------

export type SessionParseError =
  | { kind: 'ndjson_parse_failed'; line: number; detail: string }
  | { kind: 'meta_invalid_shape'; detail: string }
  | { kind: 'first_event_not_session_start'; actualKind: string }
  | { kind: 'session_id_mismatch'; slogSessionId: string; metaSessionId: string };

// ---------------------------------------------------------------------------
// BundleFiles — raw unzipped content
// ---------------------------------------------------------------------------

export type SessionFiles = {
  /** Session UUID extracted from the filename (e.g. `session-<uuid>.slog`). */
  sessionId: string;
  /** Raw NDJSON text of the .slog file. */
  slogText: string;
  /** Raw JSON text of the .slog.meta file. */
  metaJson: string;
};

export type BundleFiles = {
  /** Raw text content of manifest.json. */
  manifestJson: string;
  /** Raw hex content of manifest.sig. */
  manifestSigHex: string;
  /** One entry per session pair found in the ZIP. */
  sessions: SessionFiles[];
};

// ---------------------------------------------------------------------------
// ParsedSession — result of parse-session.ts
// ---------------------------------------------------------------------------

export type ParsedSession = {
  sessionId: string;
  events: HashedEnvelope[];
  meta: SlogMeta;
  /** Narrowed to session.start — guaranteed to be the first event. */
  firstEvent: HashedEnvelope<'session.start'> & { data: SessionStartPayload };
};

// ---------------------------------------------------------------------------
// Bundle — fully loaded, sorted, validated
// ---------------------------------------------------------------------------

export type Bundle = {
  manifest: BundleManifest;
  /** Hex-encoded ed25519 signature over canonical manifest JSON. */
  manifestSigHex: string;
  /** Sessions sorted oldest → newest by firstEvent.data.wall. */
  sessions: ParsedSession[];
  /** Original filename of the ZIP that was loaded. */
  sourceFilename: string;
  /** ISO timestamp of when loadBundle() was called; used for export headers. */
  loadedAt: string;
};
