import { describe, expect, it } from 'vitest';
import {
  buildExternalChangeContent,
  MAX_INLINE_BYTES,
  HEAD_TAIL_BYTES,
} from './external-change-content.js';

describe('buildExternalChangeContent', () => {
  it('short text (< 4 KB): inlines new_content, no head/tail', () => {
    const text = 'def foo(): pass\n';
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_head).toBeUndefined();
    expect(result.new_content_tail).toBeUndefined();
    expect(result.new_content_size).toBe(text.length);
  });

  it('text exactly at 4096 bytes: inlines (boundary inclusive)', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES);
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_head).toBeUndefined();
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES);
  });

  it('text exceeding 4096 bytes: sets head + tail, no inline new_content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES + 1);
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBeUndefined();
    expect(result.new_content_head).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.new_content_tail).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES + 1);
  });

  it('large text: head is first 512 chars, tail is last 512 chars', () => {
    const head = 'H'.repeat(HEAD_TAIL_BYTES);
    const middle = 'M'.repeat(5000);
    const tail = 'T'.repeat(HEAD_TAIL_BYTES);
    const text = head + middle + tail;
    const result = buildExternalChangeContent(text);
    expect(result.new_content_head).toBe(head);
    expect(result.new_content_tail).toBe(tail);
  });

  it('new_content_size is UTF-8 byte length, not JS char length', () => {
    const emoji = '😀'; // 4 bytes in UTF-8, length=2 in JS (surrogate pair)
    const result = buildExternalChangeContent(emoji);
    expect(result.new_content_size).toBe(4);
    expect(result.new_content_size).not.toBe(emoji.length);
  });

  it('empty text: inlines empty string, size=0', () => {
    const result = buildExternalChangeContent('');
    expect(result.new_content).toBe('');
    expect(result.new_content_size).toBe(0);
  });
});
