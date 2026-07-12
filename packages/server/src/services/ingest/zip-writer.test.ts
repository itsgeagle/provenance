import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { writeDeflateZip } from './zip-writer.js';

/**
 * JSZip validates each entry's CRC-32 when `.async()` decompresses it, so a
 * clean round-trip through JSZip is a strong correctness check on the writer's
 * headers, CRC, and DEFLATE stream.
 */
describe('writeDeflateZip', () => {
  const enc = new TextEncoder();

  it('produces a zip JSZip reads back byte-identically', async () => {
    const entries = [
      { name: 'manifest.json', data: enc.encode(`{"a":1,"b":"${'x'.repeat(2000)}"}`) },
      { name: 'session-1.slog', data: enc.encode('line\n'.repeat(5000)) },
      { name: 'session-1.slog.meta', data: enc.encode('{"m":true}') },
    ];

    const zipBytes = await writeDeflateZip(entries);
    const read = await JSZip.loadAsync(zipBytes);

    for (const e of entries) {
      const back = await read.file(e.name)!.async('uint8array');
      expect(back).toEqual(e.data);
    }
    // Only the three entries, no directories.
    expect(Object.keys(read.files).sort()).toEqual(
      ['manifest.json', 'session-1.slog', 'session-1.slog.meta'].sort(),
    );
  });

  it('compresses highly-repetitive data (DEFLATE actually applied)', async () => {
    const data = enc.encode('x'.repeat(100_000));
    const zipBytes = await writeDeflateZip([{ name: 'big.slog', data }]);
    // Compressed entry + headers must be far smaller than the raw payload.
    expect(zipBytes.length).toBeLessThan(data.length / 2);
    const back = await (await JSZip.loadAsync(zipBytes)).file('big.slog')!.async('uint8array');
    expect(back).toEqual(data);
  });

  it('falls back to STORE for incompressible/empty entries without growing them', async () => {
    // Random-ish bytes do not shrink under DEFLATE; the writer must STORE them.
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) & 0xff;
    const zipBytes = await writeDeflateZip([
      { name: 'empty', data: new Uint8Array(0) },
      { name: 'rand', data },
    ]);
    const read = await JSZip.loadAsync(zipBytes);
    expect(await read.file('empty')!.async('uint8array')).toEqual(new Uint8Array(0));
    expect(await read.file('rand')!.async('uint8array')).toEqual(data);
  });

  it('is byte-deterministic across calls', async () => {
    const entries = [{ name: 'a.slog', data: enc.encode('hello\n'.repeat(1000)) }];
    const a = await writeDeflateZip(entries);
    const b = await writeDeflateZip(entries);
    expect(a).toEqual(b);
  });
});
