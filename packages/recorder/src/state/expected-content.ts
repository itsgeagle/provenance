/**
 * ExpectedContent — in-memory model of a file's current content.
 * Used as the foundation for external-change detection (Phase 7).
 *
 * The "streaming" aspect is per-file hash tracking; we recompute SHA-256
 * from the full content on each access (memoized, invalidated on change).
 * Full recompute is fine for typical CS 61A file sizes (kilobytes).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Delta shape (mirrors vscode.TextDocumentContentChangeEvent geometry)
// ---------------------------------------------------------------------------

export type Delta = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ExpectedContent {
  private _content: string;
  private _hash: string | null = null; // null = needs recompute

  /** Construct from the initial known content of a file (typically read at doc.open). */
  constructor(initialContent: string) {
    this._content = initialContent;
  }

  /** Current full content. */
  get content(): string {
    return this._content;
  }

  /** Line count. Empty string → 0. Non-empty with no \n → 1. Trailing \n counts empty line. */
  get lineCount(): number {
    if (this._content === '') return 0;
    // Count newlines + 1
    let count = 1;
    for (let i = 0; i < this._content.length; i++) {
      if (this._content[i] === '\n') count++;
    }
    return count;
  }

  /** Current hex sha256 of the full content. Memoized; invalidated by applyDelta/reset. */
  get hash(): string {
    if (this._hash === null) {
      this._hash = bytesToHex(sha256(new TextEncoder().encode(this._content)));
    }
    return this._hash;
  }

  /** Apply a single doc.change delta. Updates content + invalidates cached hash. */
  applyDelta(delta: Delta): void {
    const { startOffset, endOffset } = this._resolveRange(delta.range);
    this._content =
      this._content.slice(0, startOffset) + delta.text + this._content.slice(endOffset);
    this._hash = null;
  }

  /** Apply many deltas in order. */
  applyDeltas(deltas: ReadonlyArray<Delta>): void {
    for (const delta of deltas) {
      this.applyDelta(delta);
    }
  }

  /** Replace content entirely (e.g., after fs.external_change reconciliation). */
  reset(content: string): void {
    this._content = content;
    this._hash = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert a {line, character} range to {startOffset, endOffset} in the content string.
   * Newlines are \n. Clamps defensively to valid bounds.
   */
  private _resolveRange(range: Delta['range']): { startOffset: number; endOffset: number } {
    return {
      startOffset: this._positionToOffset(range.start),
      endOffset: this._positionToOffset(range.end),
    };
  }

  private _positionToOffset(pos: { line: number; character: number }): number {
    const content = this._content;
    let line = 0;
    let i = 0;

    // Advance line-by-line
    while (i < content.length && line < pos.line) {
      if (content[i] === '\n') line++;
      i++;
    }

    // Now add character offset, clamped to end of line / end of content
    const remaining = content.length - i;
    const charOffset = Math.min(pos.character, remaining);
    return i + charOffset;
  }
}
