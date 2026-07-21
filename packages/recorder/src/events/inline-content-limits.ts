/**
 * inline-content-limits.ts — the single source of truth for how much content
 * the recorder is willing to inline into one event payload.
 *
 * Three payloads carry file/text content inline: `doc.open` (`content`),
 * `paste` (`content`), and `fs.external_change` (`new_content`). All three used
 * to declare their own ceiling; `doc.open` was already 64 KB while the other
 * two were 4 KB. They are unified here because they answer the same question —
 * "how large a blob may a single event carry?" — and drifting them apart again
 * is exactly the kind of change that should be visible in one diff.
 *
 * WHY 64 KB AND NOT 4 KB (recorder PRD §4.3 / §4.5)
 *
 * At 4 KB, neither a genuine external write nor a large paste to a real-sized
 * source file was ever recoverable: the evidence was discarded at record time,
 * so no analyzer-side fix could bring it back.
 *
 *   - fs.external_change: above the cap the analyzer sees only head/tail and a
 *     hash, so it cannot reconstruct the post-change file, and the
 *     `mass_external_replacement` heuristic cannot evaluate the change at all.
 *   - paste: `paste` events are NOT duplicated by `doc.change`, so a pasted
 *     solution above the cap was unrecoverable in reconstruction AND invisible
 *     to the paste heuristics — the single most load-bearing detection case in
 *     the product.
 *
 * This is a THRESHOLD change, not a schema change. `content` / `new_content`
 * are already optional fields, so old and new analyzers interoperate in both
 * directions and `format_version` is deliberately NOT bumped.
 *
 * ORDERING NOTE: raising this cap is only affordable because the D1 save-time
 * race is fixed. Before that fix the recorder emitted ~21 false
 * `fs.external_change` events per submission; at 64 KB each, that would have
 * added a megabyte or more of duplicated source per student.
 */

/**
 * Maximum UTF-8 byte length of content inlined into a single event payload.
 *
 * Measured with `Buffer.byteLength(text, 'utf8')` — NOT `string.length`.
 * A multi-byte codepoint counts as more than one byte, so a string of 40 000
 * emoji is well over the cap despite being far fewer than 65 536 characters.
 *
 * The boundary is INCLUSIVE: content of exactly MAX_INLINE_BYTES is inlined.
 */
export const MAX_INLINE_BYTES = 64 * 1024; // 64 KB

/**
 * How much of the head and of the tail to retain when content exceeds
 * MAX_INLINE_BYTES. Deliberately unchanged at 512: it is a "what did this look
 * like?" affordance for staff, not a reconstruction input.
 *
 * Note these are CHARACTER slices, not byte slices, so that truncation can
 * never split a multi-byte codepoint and produce invalid UTF-8.
 */
export const HEAD_TAIL_BYTES = 512;
