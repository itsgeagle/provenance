import { describe, expect, it } from 'vitest';
import { buildPastePayload, MAX_INLINE_BYTES, HEAD_TAIL_BYTES } from './paste-payload.js';

describe('buildPastePayload', () => {
  it('short text (< 4KB): sets content, no head/tail', () => {
    const text = 'hello world';
    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.content_head).toBeUndefined();
    expect(result.content_tail).toBeUndefined();
  });

  it('text exactly at 4096 bytes: sets content (boundary inclusive)', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES);
    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.content_head).toBeUndefined();
  });

  it('text exceeding 4096 bytes: sets head/tail, no content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES + 1);
    const result = buildPastePayload(text);
    expect(result.content).toBeUndefined();
    expect(result.content_head).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.content_tail).toBe('a'.repeat(HEAD_TAIL_BYTES));
  });

  it('large text: head is first 512 chars, tail is last 512 chars', () => {
    // Build text where head and tail are distinct
    const head = 'H'.repeat(HEAD_TAIL_BYTES);
    const middle = 'M'.repeat(5000);
    const tail = 'T'.repeat(HEAD_TAIL_BYTES);
    const text = head + middle + tail;
    const result = buildPastePayload(text);
    expect(result.content_head).toBe(head);
    expect(result.content_tail).toBe(tail);
  });

  it('length is UTF-8 byte length, not char length (multi-byte chars)', () => {
    // Each emoji is 4 bytes in UTF-8, 2 chars in JS (surrogate pair)
    const emoji = '😀'; // 4 bytes, length=2 in JS
    const result = buildPastePayload(emoji);
    expect(result.length).toBe(4); // byte length
    expect(result.length).not.toBe(emoji.length); // NOT char length (which would be 2)
  });

  it('length matches Buffer.byteLength for ASCII text', () => {
    const text = 'hello';
    const result = buildPastePayload(text);
    expect(result.length).toBe(5);
    expect(result.length).toBe(text.length); // same for ASCII
  });

  it('sha256 is 64-char lowercase hex', () => {
    const result = buildPastePayload('test');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256 is deterministic for same input', () => {
    const text = 'deterministic test';
    expect(buildPastePayload(text).sha256).toBe(buildPastePayload(text).sha256);
  });

  it('sha256 differs for different inputs', () => {
    expect(buildPastePayload('abc').sha256).not.toBe(buildPastePayload('def').sha256);
  });

  it('empty string: length=0, content=""', () => {
    const result = buildPastePayload('');
    expect(result.length).toBe(0);
    expect(result.content).toBe('');
    expect(result.content_head).toBeUndefined();
  });
});
