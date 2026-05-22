/**
 * Filename convention validation and parsing (PRD §9.2).
 *
 * A semester's `filename_convention` is a JavaScript-compatible regex string
 * (ECMA-262 syntax). Named groups expected:
 *   - `sid`            — required
 *   - `assignment_id`  — optional; fallback to bundle manifest if absent
 *
 * Validation rules (PRD §9.2):
 *   1. Must compile (new RegExp(regex) succeeds).
 *   2. Must contain a (?<sid>...) named capture group.
 *   3. Length ≤ 500 chars.
 *   4. May not use the 'g' (global) or 'y' (sticky) flags — those interfere
 *      with per-filename matching semantics.
 *
 * This module is pure — no I/O, no DB, no HTTP. Safe to use from anywhere.
 */

// ---------------------------------------------------------------------------
// validateFilenameConvention
// ---------------------------------------------------------------------------

export type ValidateResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a filename convention regex string per PRD §9.2.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error: string }` on failure.
 * Never throws.
 */
export function validateFilenameConvention(regex: string): ValidateResult {
  if (regex.length > 500) {
    return { ok: false, error: 'Filename convention regex must be ≤ 500 characters' };
  }

  // Compile check.
  let compiled: RegExp;
  try {
    compiled = new RegExp(regex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Filename convention regex does not compile: ${msg}` };
  }

  // Forbidden flags check.
  // The caller passes only the pattern string (no flags). We use `new RegExp(regex)`
  // above so flags are always empty. However, some engines allow inline flag syntax
  // (?flags:...) or (?flags-flags:...) embedded in the pattern; we do not need to
  // special-case those since inline flags don't attach to `compiled.flags`.
  // The `g` and `y` flag check below guards against `new RegExp(regex, 'g')` usage
  // but since we always call `new RegExp(regex)` with no flags, this is belt-and-suspenders.
  if (compiled.flags.includes('g') || compiled.flags.includes('y')) {
    return {
      ok: false,
      error: "Filename convention regex must not use the 'g' (global) or 'y' (sticky) flags",
    };
  }

  // Must include (?<sid>...) named capture group.
  if (!hasSidGroup(regex)) {
    return {
      ok: false,
      error: "Filename convention regex must contain a (?<sid>...) named capture group",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// parseFilenameWithConvention
// ---------------------------------------------------------------------------

export interface ParseFilenameResult {
  /** Extracted student id from the (?<sid>...) group. */
  sid?: string;
  /** Extracted assignment id from the (?<assignment_id>...) group, if present. */
  assignment_id?: string;
}

/**
 * Apply a filename convention regex to a filename and extract named groups.
 *
 * Returns `null` if the regex does not match or the regex fails to compile
 * (compile errors should have been caught by `validateFilenameConvention` at
 * semester creation time; this is a safety valve).
 *
 * Returns a `ParseFilenameResult` with `sid` (always if the regex is valid)
 * and optionally `assignment_id` if the pattern contains that group.
 *
 * Callers should pass a pre-validated regex (one that passed
 * `validateFilenameConvention`). If `sid` is absent from the match groups,
 * returns `null` to signal failure gracefully.
 */
export function parseFilenameWithConvention(
  regex: string,
  filename: string,
): ParseFilenameResult | null {
  let compiled: RegExp;
  try {
    compiled = new RegExp(regex);
  } catch {
    return null;
  }

  const match = compiled.exec(filename);
  if (!match || !match.groups) {
    return null;
  }

  const sid = match.groups['sid'];
  if (sid === undefined) {
    // Regex matched but has no sid group — should not happen after validation.
    return null;
  }

  const result: ParseFilenameResult = { sid };

  const assignmentId = match.groups['assignment_id'];
  if (assignmentId !== undefined) {
    result.assignment_id = assignmentId;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the regex string contains a (?<sid>...) named capture group.
 *
 * Uses a simple heuristic regex rather than full parsing: looks for the
 * literal sequence `(?<sid>` which is the standard ECMA-262 named group syntax.
 * The assumption is that the convention author uses standard syntax; exotic
 * equivalents (e.g. embedded in alternation with escaped brackets) are edge
 * cases not worth full parsing.
 */
function hasSidGroup(regex: string): boolean {
  return regex.includes('(?<sid>');
}
