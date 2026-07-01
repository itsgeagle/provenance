/**
 * pdf-renderer.ts — jsPDF-based layout for the Provenance findings PDF.
 *
 * PRD §7.5: export includes cover page, validation report, flag list with
 * embedded screenshots, and an appendix.
 *
 * Page: US Letter (8.5 × 11 in = 612 × 792 pt) with 72 pt (1 in) margins.
 *
 * This module is a PURE layout engine — it accepts pre-rendered screenshots
 * (base64 PNGs) as data URLs and embeds them. The screenshot capture logic
 * lives in screenshot.ts; the orchestrator lives in findings-pdf.ts.
 *
 * Injection safety (same concern as Phase 8 / §6):
 *   All strings from recorder-supplied fields (flag titles, descriptions,
 *   assignment_id, etc.) pass through `sanitizeForPdf()` before being handed
 *   to jsPDF `.text()` calls. `sanitizeForPdf` collapses newlines to spaces
 *   so nothing can corrupt the positional text layout.
 */

import { jsPDF } from 'jspdf';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag, Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// Page geometry constants (US Letter, pt units)
// ---------------------------------------------------------------------------

const PAGE_W = 612; // 8.5 in × 72 pt/in
const PAGE_H = 792; // 11 in × 72 pt/in
const MARGIN = 72; // 1 in
const CONTENT_W = PAGE_W - 2 * MARGIN; // 468 pt

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A screenshot to embed alongside a flag.
 *
 * `flagId` matches `Flag.id`. `dataUrl` is a base64-encoded PNG data URL
 * (e.g. "data:image/png;base64,..."). `label` is a short caption shown
 * under the image (e.g. "Event at seq 42, session abc").
 */
export type FlagScreenshot = {
  flagId: string;
  dataUrl: string; // "data:image/png;base64,..."
  label: string;
};

/**
 * Input to `renderPdf`.
 *
 * `screenshots` is parallel to `flags`: each flag may have zero or one entry.
 * If the array is empty or a flag has no matching entry, that flag section
 * renders text only.
 */
export type PdfRenderInput = {
  bundle: Bundle;
  report: ValidationReport;
  flags: Flag[];
  screenshots: FlagScreenshot[];
  generatedAt: Date;
  /** Optional hex sha256 of the bundle ZIP (same optional semantics as Phase 8). */
  bundleSha256?: string;
};

// ---------------------------------------------------------------------------
// Internal layout state
// ---------------------------------------------------------------------------

/**
 * Mutable cursor that tracks where the next text element lands.
 * We advance `y` as we add content; when it nears the bottom margin we
 * call `newPage()` to get a fresh page.
 */
type Cursor = {
  doc: jsPDF;
  y: number;
};

function newPage(cur: Cursor): void {
  cur.doc.addPage();
  cur.y = MARGIN;
}

/**
 * Advance cursor by `delta` pt. If the result would be past the bottom
 * margin, start a new page first (and re-advance from the top margin).
 */
function advance(cur: Cursor, delta: number): void {
  if (cur.y + delta > PAGE_H - MARGIN) {
    newPage(cur);
  } else {
    cur.y += delta;
  }
}

/**
 * Draw wrapped text at the current cursor position.
 * Returns the cursor so the caller can chain.
 *
 * Each line of wrapped text is drawn at MARGIN, cur.y. Line height = fontSize * 1.4.
 * `maxWidth` defaults to CONTENT_W.
 */
function drawText(
  cur: Cursor,
  text: string,
  fontSize: number,
  opts: {
    bold?: boolean;
    color?: [number, number, number]; // RGB 0-255
    maxWidth?: number;
    indent?: number; // left offset from MARGIN
  } = {},
): void {
  const { bold = false, color = [0, 0, 0], maxWidth = CONTENT_W, indent = 0 } = opts;

  cur.doc.setFontSize(fontSize);
  cur.doc.setFont('helvetica', bold ? 'bold' : 'normal');
  cur.doc.setTextColor(color[0], color[1], color[2]);

  const lines: string[] = cur.doc.splitTextToSize(sanitizeForPdf(text), maxWidth - indent);
  const lineH = fontSize * 1.4;

  for (const line of lines) {
    if (cur.y + lineH > PAGE_H - MARGIN) {
      newPage(cur);
    }
    cur.doc.text(line, MARGIN + indent, cur.y);
    cur.y += lineH;
  }
}

/**
 * Draw a horizontal rule (thin line).
 */
function drawRule(cur: Cursor): void {
  const y = cur.y;
  cur.doc.setDrawColor(200, 200, 200);
  cur.doc.setLineWidth(0.5);
  cur.doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  cur.y += 8;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderCoverPage(cur: Cursor, input: PdfRenderInput): void {
  cur.y = MARGIN;

  // Title
  drawText(cur, 'Provenance Findings Report', 24, { bold: true });
  advance(cur, 12);
  drawRule(cur);
  advance(cur, 8);

  const { bundle, report, flags, generatedAt, bundleSha256 } = input;

  // Metadata table
  const rows: [string, string][] = [
    ['Assignment', sanitizeForPdf(bundle.manifest.assignment_id)],
    ['Semester', sanitizeForPdf(bundle.manifest.semester)],
    ['Bundle filename', sanitizeForPdf(bundle.sourceFilename)],
    ['Bundle sha256', bundleSha256 ?? '(not available)'],
    ['Extension hash', sanitizeForPdf(bundle.manifest.extension_hash)],
    ['Sessions', String(bundle.sessions.length)],
    ['Flags', String(flags.length)],
    ['Validation overall', report.overall],
    ['Generated at', generatedAt.toISOString()],
  ];

  const labelW = 130;
  for (const [label, value] of rows) {
    if (cur.y + 14 > PAGE_H - MARGIN) newPage(cur);
    cur.doc.setFontSize(10);
    cur.doc.setFont('helvetica', 'bold');
    cur.doc.setTextColor(60, 60, 60);
    cur.doc.text(label + ':', MARGIN, cur.y);
    cur.doc.setFont('helvetica', 'normal');
    cur.doc.setTextColor(0, 0, 0);
    const valueLines: string[] = cur.doc.splitTextToSize(sanitizeForPdf(value), CONTENT_W - labelW);
    cur.doc.text(valueLines[0] ?? '', MARGIN + labelW, cur.y);
    cur.y += 14;
    for (let i = 1; i < valueLines.length; i++) {
      if (cur.y + 14 > PAGE_H - MARGIN) newPage(cur);
      cur.doc.text(valueLines[i] ?? '', MARGIN + labelW, cur.y);
      cur.y += 14;
    }
  }
}

function renderValidationSection(cur: Cursor, report: ValidationReport): void {
  newPage(cur);

  drawText(cur, 'Validation Report', 16, { bold: true });
  advance(cur, 6);
  drawRule(cur);
  advance(cur, 4);

  drawText(cur, `Overall: ${report.overall}`, 11, {
    bold: true,
    color: report.overall === 'pass' ? [34, 139, 34] : [180, 0, 0],
  });
  advance(cur, 8);

  // Table header
  const colWidths = [160, 50, CONTENT_W - 210] as const;
  const colX = [MARGIN, MARGIN + 160, MARGIN + 210] as const;
  const rowH = 14;

  const drawTableRow = (cells: [string, string, string], bold: boolean, headerBg: boolean) => {
    if (cur.y + rowH + 4 > PAGE_H - MARGIN) newPage(cur);
    if (headerBg) {
      cur.doc.setFillColor(240, 240, 240);
      cur.doc.rect(MARGIN, cur.y - rowH + 2, CONTENT_W, rowH + 2, 'F');
    }
    cur.doc.setFontSize(9);
    cur.doc.setFont('helvetica', bold ? 'bold' : 'normal');
    cur.doc.setTextColor(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const cell = cells[i]!;
      const lines: string[] = cur.doc.splitTextToSize(sanitizeForPdf(cell), colWidths[i]! - 4);
      cur.doc.text(lines[0] ?? '', colX[i]!, cur.y);
    }
    cur.y += rowH;
  };

  drawTableRow(['Check', 'Status', 'Detail'], true, true);
  advance(cur, 2);

  for (const check of report.checks) {
    const statusColor: [number, number, number] =
      check.status === 'pass'
        ? [34, 139, 34]
        : check.status === 'fail'
          ? [180, 0, 0]
          : [120, 120, 120];
    if (cur.y + rowH + 2 > PAGE_H - MARGIN) newPage(cur);

    cur.doc.setFontSize(9);
    cur.doc.setFont('helvetica', 'normal');
    cur.doc.setTextColor(0, 0, 0);
    cur.doc.text(sanitizeForPdf(check.label), colX[0]!, cur.y);

    cur.doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
    cur.doc.text(check.status, colX[1]!, cur.y);

    cur.doc.setTextColor(80, 80, 80);
    const detailLines: string[] = cur.doc.splitTextToSize(
      sanitizeForPdf(check.detail ?? ''),
      colWidths[2]! - 4,
    );
    cur.doc.text(detailLines[0] ?? '', colX[2]!, cur.y);
    cur.y += rowH;

    for (let i = 1; i < detailLines.length; i++) {
      if (cur.y + rowH > PAGE_H - MARGIN) newPage(cur);
      cur.doc.text(detailLines[i] ?? '', colX[2]!, cur.y);
      cur.y += rowH;
    }
  }
}

function renderFlagsSection(cur: Cursor, flags: Flag[], screenshots: FlagScreenshot[]): void {
  newPage(cur);

  drawText(cur, 'Heuristic Flags', 16, { bold: true });
  advance(cur, 6);
  drawRule(cur);
  advance(cur, 4);

  if (flags.length === 0) {
    drawText(cur, 'No flags were raised by the heuristic suite.', 10, {
      color: [80, 80, 80],
    });
    return;
  }

  // Index screenshots by flagId for O(1) lookup.
  const screenshotByFlagId = new Map<string, FlagScreenshot>();
  for (const s of screenshots) {
    screenshotByFlagId.set(s.flagId, s);
  }

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;

    // Each flag starts on the same page unless near-bottom.
    if (cur.y + 40 > PAGE_H - MARGIN) newPage(cur);

    // Flag heading
    advance(cur, 6);
    drawText(cur, `${i + 1}. ${flag.title}`, 12, { bold: true });

    // Severity badge: colored label
    const severityColor = severityRgb(flag.severity);
    advance(cur, 2);
    cur.doc.setFontSize(9);
    cur.doc.setFont('helvetica', 'bold');
    cur.doc.setTextColor(severityColor[0], severityColor[1], severityColor[2]);
    cur.doc.text(flag.severity.toUpperCase(), MARGIN, cur.y);

    cur.doc.setFont('helvetica', 'normal');
    cur.doc.setTextColor(80, 80, 80);
    cur.doc.text(
      `  heuristic: ${sanitizeForPdf(flag.heuristic)}   confidence: ${flag.confidence.toFixed(2)}   events: ${flag.supportingSeqs.length}`,
      MARGIN + 40,
      cur.y,
    );
    advance(cur, 14);

    // Description
    drawText(cur, flag.description, 10, { color: [40, 40, 40] });
    advance(cur, 4);

    // Supporting seq keys (compact list, max 5 shown)
    if (flag.supportingSeqs.length > 0) {
      const shown = flag.supportingSeqs.slice(0, 5);
      const more = flag.supportingSeqs.length - shown.length;
      const keysText = 'Events: ' + shown.join(', ') + (more > 0 ? `, …+${more} more` : '');
      drawText(cur, keysText, 9, { color: [80, 80, 80] });
      advance(cur, 4);
    }

    // Screenshot (if available)
    const shot = screenshotByFlagId.get(flag.id);
    if (shot !== undefined) {
      embedScreenshot(cur, shot);
    }

    advance(cur, 4);
    drawRule(cur);
  }
}

/**
 * Embed a screenshot PNG into the PDF. The image is scaled to fill the
 * content width while maintaining aspect ratio, capped at 300 pt height
 * to avoid single-image pages.
 *
 * NOTE: We cannot know the PNG dimensions without parsing the image header.
 * jsPDF's `addImage` accepts width+height in doc units. We default to a
 * 16:9 ratio (standard screen) and let jsPDF stretch if needed. Course staff
 * rendering will see accurate proportions because the screenshots are
 * produced from a fixed-size div in screenshot.ts.
 */
function embedScreenshot(cur: Cursor, shot: FlagScreenshot): void {
  // Target image width: full content width. Assume 16:10 ratio (code editor).
  const imgW = CONTENT_W;
  const imgH = Math.min(imgW * 0.5, 280); // cap at 280 pt

  // Ensure there's room; if not, start a new page.
  if (cur.y + imgH + 20 > PAGE_H - MARGIN) {
    newPage(cur);
  }

  try {
    cur.doc.addImage(shot.dataUrl, 'PNG', MARGIN, cur.y, imgW, imgH);
    cur.y += imgH + 6;

    // Caption
    cur.doc.setFontSize(8);
    cur.doc.setFont('helvetica', 'italic');
    cur.doc.setTextColor(100, 100, 100);
    cur.doc.text(sanitizeForPdf(shot.label), MARGIN, cur.y);
    cur.y += 12;
  } catch {
    // If the data URL is invalid (e.g. empty in tests), skip silently.
    cur.doc.setFontSize(8);
    cur.doc.setFont('helvetica', 'italic');
    cur.doc.setTextColor(150, 0, 0);
    cur.doc.text('(screenshot not available)', MARGIN, cur.y);
    cur.y += 12;
  }
}

function renderAppendix(cur: Cursor, bundle: Bundle, flags: Flag[]): void {
  newPage(cur);

  drawText(cur, 'Appendix: Sample Supporting Events', 16, { bold: true });
  advance(cur, 6);
  drawRule(cur);
  advance(cur, 4);

  let hasAny = false;
  for (const flag of flags) {
    const firstKey = flag.supportingSeqs[0];
    if (firstKey === undefined) continue;

    hasAny = true;

    advance(cur, 4);
    drawText(cur, `${flag.heuristic} — ${firstKey}`, 10, { bold: true });
    advance(cur, 2);

    const envelope = findEnvelope(bundle, firstKey);
    if (envelope === null) {
      drawText(cur, `(event ${firstKey} not found in bundle)`, 9, {
        color: [120, 120, 120],
      });
    } else {
      const json = JSON.stringify(envelope, null, 2);
      // Render JSON as a monospaced block, line by line.
      cur.doc.setFontSize(8);
      cur.doc.setFont('courier', 'normal');
      cur.doc.setTextColor(40, 40, 40);
      const jsonLines = json.split('\n');
      for (const line of jsonLines) {
        if (cur.y + 10 > PAGE_H - MARGIN) newPage(cur);
        cur.doc.text(sanitizeForPdf(line), MARGIN + 8, cur.y);
        cur.y += 10;
      }
    }
    advance(cur, 4);
    drawRule(cur);
  }

  if (!hasAny) {
    drawText(cur, 'No supporting events available.', 10, {
      color: [80, 80, 80],
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render the full PDF and return the jsPDF instance.
 *
 * Callers use `doc.output('blob')` to get a Blob for download, or
 * `doc.output('datauristring')` to get a data URL.
 *
 * This function is essentially pure given a fixed jsPDF instance — it
 * doesn't call Date.now() or access the DOM. The `generatedAt` field in
 * `input` is the injected clock.
 *
 * For testability: pass `{ mockDoc }` in the third argument to inject a
 * mock jsPDF instance that records calls without producing real PDF bytes.
 */
export function renderPdf(input: PdfRenderInput, options: { mockDoc?: jsPDF } = {}): jsPDF {
  const doc =
    options.mockDoc ??
    new jsPDF({
      unit: 'pt',
      format: 'letter',
      orientation: 'portrait',
    });

  const cur: Cursor = { doc, y: MARGIN };

  renderCoverPage(cur, input);
  renderValidationSection(cur, input.report);
  renderFlagsSection(cur, input.flags, input.screenshots);
  renderAppendix(cur, input.bundle, input.flags);

  return doc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityRgb(s: Severity): [number, number, number] {
  switch (s) {
    case 'high':
      return [180, 0, 0];
    case 'medium':
      return [180, 100, 0];
    case 'low':
      return [0, 80, 180];
    case 'info':
      return [80, 80, 80];
  }
}

function findEnvelope(bundle: Bundle, key: string): unknown {
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

/**
 * Sanitize a recorder-supplied string for safe embedding in PDF text calls.
 *
 * jsPDF's `.text()` does not interpret newlines in strings — they cause
 * layout corruption (the text cursor jumps but the position argument is
 * already fixed). We collapse CR/LF runs to a single space, matching the
 * Phase 8 `escapeInlineMarkdown` convention.
 *
 * Also collapses null bytes which can corrupt PDF streams.
 */
export function sanitizeForPdf(s: string): string {
  return s.replace(/[\r\n\0]+/g, ' ');
}

/**
 * Derive a filename for the PDF export.
 *
 * Format: `findings-<assignment-id>-<YYYYMMDD-HHMMSS>.pdf`
 * Mirrors Phase 8's `filenameFor` in findings-markdown.ts.
 */
export function pdfFilenameFor(bundle: Bundle, generatedAt: Date): string {
  const assignment = sanitizeForFilename(bundle.manifest.assignment_id);
  const ts = formatTimestampForFilename(generatedAt);
  return `findings-${assignment}-${ts}.pdf`;
}

function sanitizeForFilename(s: string): string {
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
