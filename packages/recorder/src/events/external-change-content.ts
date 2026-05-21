/**
 * external-change-content.ts — pure helper that fills the inline-content
 * fields on FsExternalChangePayload.
 *
 * Mirrors the paste-payload truncation pattern (PRD §4.3 last paragraph):
 * inline the full text up to 4 KB, otherwise store head + tail + size.
 * Lets the analyzer reseed reconstruction after an external write so the
 * replay UI can show the post-change file (PRD §4.5 / §7.2).
 *
 * Constants intentionally match paste-payload.ts so a future refactor can
 * unify them; we don't share imports today because the paste helper also
 * computes `length` + `sha256` (which fs.external_change already has).
 */

export type ExternalChangeContentFields = {
  new_content_size: number;
  /** Full post-change content if size <= MAX_INLINE_BYTES. */
  new_content?: string;
  /** First HEAD_TAIL_BYTES chars if size > MAX_INLINE_BYTES. */
  new_content_head?: string;
  /** Last HEAD_TAIL_BYTES chars if size > MAX_INLINE_BYTES. */
  new_content_tail?: string;
};

export const MAX_INLINE_BYTES = 4096;
export const HEAD_TAIL_BYTES = 512;

/**
 * Build the content fields for an fs.external_change payload.
 *
 * `new_content_size` is the UTF-8 byte length of `text` (Buffer.byteLength,
 * not string.length — multi-byte codepoints count as more than one byte).
 * Either `new_content` is set (small file) or `new_content_head` +
 * `new_content_tail` are set (large file), never both.
 */
export function buildExternalChangeContent(text: string): ExternalChangeContentFields {
  const byteLength = Buffer.byteLength(text, 'utf8');

  if (byteLength <= MAX_INLINE_BYTES) {
    return {
      new_content_size: byteLength,
      new_content: text,
    };
  }

  return {
    new_content_size: byteLength,
    new_content_head: text.slice(0, HEAD_TAIL_BYTES),
    new_content_tail: text.slice(-HEAD_TAIL_BYTES),
  };
}
