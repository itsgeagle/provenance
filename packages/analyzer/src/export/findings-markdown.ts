/**
 * findings-markdown.ts — render a self-contained Markdown findings report.
 *
 * PRD §7.5: "The Analyzer can export a findings document (PDF or markdown) for
 * inclusion in academic integrity case files. The document includes the
 * validation report, the flag list with supporting evidence, screenshots of
 * key replay moments, and a checksum of the input bundle."
 *
 * v1 ships Markdown only; PDF + screenshots are Phase 19 (v2).
 *
 * Both functions here are PURE:
 *   - `renderFindings` takes a `generatedAt: Date` via opts; never reads
 *     Date.now(). This is the "clock injected" requirement and makes the
 *     snapshot test deterministic.
 *   - `filenameFor` derives the filename from the same injected Date.
 *
 * No DOM access here. Browser-side `downloadAs` lives in download.ts.
 */

import type { Bundle } from '../loader/types.js';
import type {
  ValidationReport,
  ValidationCheck,
  ValidationCheckId,
} from '../validation/check-types.js';
import type { Flag, Severity } from '../heuristics/types.js';
import type { HashedEnvelope } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RenderFindingsOpts = {
  /**
   * Wall-clock time the export was generated. Embedded in the header and
   * used to derive the filename. Caller injects (typically `new Date()`).
   */
  generatedAt: Date;
  /**
   * Hex sha256 of the bundle ZIP, if computed by the loader.
   *
   * In v1 the loader does NOT compute this (see analyzer-progress.md).
   * When absent, the header renders "(not available)" rather than failing.
   */
  bundleSha256?: string;
};

/**
 * Render a Markdown findings report.
 *
 * Pure function: same inputs → same string output. No I/O, no Date.now.
 *
 * Section order (PRD §7.5 prose):
 *   1. Header (assignment id, semester, bundle filename, bundle sha256,
 *      generated-at, session count, extension hash)
 *   2. Validation report (8 checks in §5.4 order)
 *   3. Flag list (one section per flag, in the caller-supplied order)
 *   4. Appendix: sample supporting event JSON (first supporting event per
 *      flag, full envelope)
 */
export function renderFindings(
  bundle: Bundle,
  report: ValidationReport,
  flags: Flag[],
  opts: RenderFindingsOpts,
): string {
  const parts: string[] = [];
  parts.push(renderHeader(bundle, report, flags, opts));
  parts.push(renderValidationSection(report));
  parts.push(renderFlagsSection(flags));
  parts.push(renderAppendix(bundle, flags));
  // Trailing newline so editors / git treat the file cleanly.
  return parts.join('\n\n') + '\n';
}

/**
 * Derive an export filename from the assignment id and generated-at time.
 *
 *   findings-<assignment-id>-<YYYYMMDD-HHMMSS>.md
 *
 * Timestamp is UTC (matches PRD §4.2 wall-clock convention; case files
 * shouldn't depend on the reviewer's timezone).
 */
export function filenameFor(bundle: Bundle, generatedAt: Date): string {
  const assignment = sanitizeForFilename(bundle.manifest.assignment_id);
  const ts = formatTimestampForFilename(generatedAt);
  return `findings-${assignment}-${ts}.md`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(
  bundle: Bundle,
  report: ValidationReport,
  flags: Flag[],
  opts: RenderFindingsOpts,
): string {
  const sha = opts.bundleSha256 ?? '(not available)';
  return [
    `# Provenance Findings Report`,
    ``,
    `- **Assignment:** ${bundle.manifest.assignment_id}`,
    `- **Semester:** ${bundle.manifest.semester}`,
    `- **Bundle filename:** ${bundle.sourceFilename}`,
    `- **Bundle sha256:** ${sha}`,
    `- **Extension hash:** ${bundle.manifest.extension_hash}`,
    `- **Sessions:** ${bundle.sessions.length}`,
    `- **Flags:** ${flags.length}`,
    `- **Validation overall:** ${report.overall}`,
    `- **Generated at:** ${opts.generatedAt.toISOString()}`,
  ].join('\n');
}

function renderValidationSection(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`## Validation report`);
  lines.push(``);
  lines.push(`Overall: **${report.overall}**`);
  lines.push(``);
  lines.push(`| Check | Status | Detail |`);
  lines.push(`| --- | --- | --- |`);
  for (const check of report.checks) {
    lines.push(
      `| ${escapeTableCell(checkDisplayName(check))} | ${check.status} | ${escapeTableCell(check.detail ?? '')} |`,
    );
  }
  return lines.join('\n');
}

function renderFlagsSection(flags: Flag[]): string {
  const lines: string[] = [];
  lines.push(`## Heuristic flags`);
  lines.push(``);

  if (flags.length === 0) {
    lines.push(`_No flags were raised by the v1 heuristic suite._`);
    return lines.join('\n');
  }

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    lines.push(`### ${i + 1}. ${flag.title}`);
    lines.push(``);
    lines.push(`- **Heuristic:** \`${flag.heuristic}\``);
    lines.push(`- **Severity:** ${severityLabel(flag.severity)}`);
    lines.push(`- **Confidence:** ${flag.confidence.toFixed(2)}`);
    lines.push(`- **Supporting events:** ${flag.supportingSeqs.length}`);
    lines.push(``);
    lines.push(flag.description);
    lines.push(``);

    if (flag.supportingSeqs.length > 0) {
      lines.push(`Supporting event keys:`);
      lines.push(``);
      for (const key of flag.supportingSeqs) {
        lines.push(`- \`${key}\``);
      }
      lines.push(``);
    }

    if (flag.detail !== undefined && Object.keys(flag.detail).length > 0) {
      lines.push(`Detail:`);
      lines.push(``);
      lines.push('```json');
      lines.push(stableStringify(flag.detail));
      lines.push('```');
      lines.push(``);
    }
  }

  // Drop trailing blank line for stable spacing — outer join adds one.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

function renderAppendix(bundle: Bundle, flags: Flag[]): string {
  const lines: string[] = [];
  lines.push(`## Appendix: sample supporting events`);
  lines.push(``);

  const entriesByFlag = collectAppendixEntries(bundle, flags);
  if (entriesByFlag.length === 0) {
    lines.push(`_No supporting events available for the flags raised, or no flags raised._`);
    return lines.join('\n');
  }

  for (const { flag, key, envelope } of entriesByFlag) {
    lines.push(`### \`${flag.heuristic}\` — first supporting event (\`${key}\`)`);
    lines.push(``);
    if (envelope === null) {
      lines.push(`_Event \`${key}\` not found in bundle._`);
      lines.push(``);
      continue;
    }
    lines.push('```json');
    lines.push(stableStringify(envelope));
    lines.push('```');
    lines.push(``);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Appendix helpers
// ---------------------------------------------------------------------------

type AppendixEntry = {
  flag: Flag;
  key: string;
  envelope: HashedEnvelope | null;
};

function collectAppendixEntries(bundle: Bundle, flags: Flag[]): AppendixEntry[] {
  const entries: AppendixEntry[] = [];
  for (const flag of flags) {
    const firstKey = flag.supportingSeqs[0];
    if (firstKey === undefined) continue;
    const envelope = findEnvelopeByKey(bundle, firstKey);
    entries.push({ flag, key: firstKey, envelope });
  }
  return entries;
}

function findEnvelopeByKey(bundle: Bundle, key: string): HashedEnvelope | null {
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) return null;
  const sessionId = key.slice(0, colonIdx);
  const seqStr = key.slice(colonIdx + 1);
  const seq = parseInt(seqStr, 10);
  if (!Number.isInteger(seq)) return null;

  const session = bundle.sessions.find((s) => s.sessionId === sessionId);
  if (session === undefined) return null;
  return session.events.find((e) => e.seq === seq) ?? null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const CHECK_DISPLAY_NAMES: Record<ValidationCheckId, string> = {
  manifest_sig: 'Manifest signature',
  session_binding: 'Session ↔ assignment binding',
  chain_integrity: 'Hash chain integrity',
  seq_gaps: 'Sequence gaps',
  monotonic_t: 'Monotonic t',
  monotonic_wall: 'Monotonic wall clock',
  doc_save_hashes: 'doc.save hash consistency',
  submitted_code_match: 'Submitted-code hash match',
};

function checkDisplayName(check: ValidationCheck): string {
  return CHECK_DISPLAY_NAMES[check.id] ?? check.label;
}

const SEVERITY_LABELS: Record<Severity, string> = {
  info: 'info',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

function severityLabel(s: Severity): string {
  return SEVERITY_LABELS[s];
}

/**
 * Escape a string so it can safely sit in a single Markdown table cell.
 * Pipes are the only character that breaks a row; newlines collapse so the
 * row stays on one line. Backticks etc. are intentionally left alone — they
 * render fine inside a cell.
 */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Stable, deterministic JSON formatter: object keys sorted alphabetically.
 *
 * Hand-rolled (no library) because we only need it to canonicalize the small
 * objects we embed in the report (flag.detail, event envelopes). JCS (used
 * by the recorder for hashing) is overkill here and would produce single-line
 * output that's hard to read in a case file.
 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, replacer(seen), 2);
}

function replacer(seen: WeakSet<object>): (this: unknown, key: string, value: unknown) => unknown {
  return function (_key, value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}

function sanitizeForFilename(s: string): string {
  // Keep alnum, dash, underscore; collapse the rest to dash.
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'bundle';
}

function formatTimestampForFilename(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mi = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}
