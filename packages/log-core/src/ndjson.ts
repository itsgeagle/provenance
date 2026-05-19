/**
 * NDJSON serialization and parsing for HashedEnvelope entries.
 * PRD §4.6 / §5.1 — log file is newline-delimited JSON, one event per line.
 */

import type { HashedEnvelope } from './envelope.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ParseError =
  | { kind: 'invalid_json'; line: number; message: string }
  | { kind: 'invalid_shape'; line: number; missing_field?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Shape-validate a parsed JSON value as a HashedEnvelope.
 * Validates that all required fields are present and have the correct basic types.
 * Does NOT validate chain linkage — that is the validator's job.
 * Does NOT reject unknown `kind` values (PRD §5.1: forward compat).
 */
function validateShape(value: unknown, lineNumber: number): Result<HashedEnvelope, ParseError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', line: lineNumber });
  }

  const obj = value as Record<string, unknown>;

  // seq: number
  if (typeof obj['seq'] !== 'number') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'seq' });
  }
  // t: number
  if (typeof obj['t'] !== 'number') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 't' });
  }
  // wall: string
  if (typeof obj['wall'] !== 'string') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'wall' });
  }
  // kind: string
  if (typeof obj['kind'] !== 'string') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'kind' });
  }
  // data: object (any shape)
  if (typeof obj['data'] !== 'object' || obj['data'] === null || Array.isArray(obj['data'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'data' });
  }
  // prev_hash: string, 64 hex chars
  if (typeof obj['prev_hash'] !== 'string' || !HEX_64_RE.test(obj['prev_hash'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'prev_hash' });
  }
  // hash: string, 64 hex chars
  if (typeof obj['hash'] !== 'string' || !HEX_64_RE.test(obj['hash'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'hash' });
  }

  // Safe cast: all required fields validated above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ok(value as HashedEnvelope<any>);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a HashedEnvelope to a single NDJSON line (JCS canonical JSON + newline).
 *
 * The canonical form ensures that hashes over these bytes remain stable regardless
 * of insertion order or whitespace.
 */
export function serializeEntry(entry: HashedEnvelope): string {
  return canonicalize(entry) + '\n';
}

/**
 * Parse a multi-line NDJSON string into an array of HashedEnvelopes.
 *
 * - Splits on '\n'.
 * - Skips empty trailing lines.
 * - JSON-parses each non-empty line and shape-validates it.
 * - Returns on the first error; does not accumulate multiple errors.
 * - Line numbers in errors are 1-indexed.
 */
export function parseEntries(text: string): Result<readonly HashedEnvelope[], ParseError> {
  // Empty string → zero entries (valid)
  if (text === '') {
    return ok([]);
  }

  const lines = text.split('\n');
  const entries: HashedEnvelope[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip empty lines (trailing newline produces one)
    if (line === '' || line === undefined) {
      continue;
    }

    const lineNumber = i + 1;

    // JSON parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ kind: 'invalid_json', line: lineNumber, message });
    }

    // Shape validate
    const result = validateShape(parsed, lineNumber);
    if (!result.ok) {
      return result;
    }

    entries.push(result.value);
  }

  return ok(entries);
}
