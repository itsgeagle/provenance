/**
 * Minimal DEFLATE ZIP writer backed by native `node:zlib`.
 *
 * Why this exists: `stripBundleSourceFiles` previously produced the stored
 * provenance-only bundle with JSZip's `generateAsync({ compression: 'DEFLATE',
 * level: 6 })`. JSZip compresses with pako — pure JavaScript running on the main
 * thread — so the DEFLATE of a submission's (often multi-MB) `.slog` logs
 * competes with the O(n²) stats/validation/heuristics for the same thread during
 * ingest. Native `zlib.deflateRaw` is both much faster and, crucially, runs on
 * the libuv threadpool (we set `UV_THREADPOOL_SIZE=16`), so it lifts the
 * compression off the analysis hot path.
 *
 * DEFLATE is lossless: the stored zip's raw bytes differ from JSZip's, but the
 * DECOMPRESSED entry content is byte-identical, so the signed `manifest.json` /
 * `manifest.sig` still verify after a round-trip through the loader. Output is
 * byte-deterministic (fixed DOS timestamp, caller-controlled entry order) so a
 * given input yields a reproducible blob.
 *
 * Scope: writes STORE-or-DEFLATE local entries + central directory + EOCD, no
 * zip64, no data descriptors, no encryption. Bundles are far below the 4 GiB
 * per-field limits, so 32-bit fields are sufficient.
 */

import { promisify } from 'node:util';
import { deflateRaw as deflateRawCb } from 'node:zlib';

const deflateRaw = promisify(deflateRawCb);

/** One entry to place at the zip root. `data` is the uncompressed bytes. */
export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), table-driven. ZIP stores the CRC of the UNCOMPRESSED
// bytes per entry.
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Field writers (all ZIP integers are little-endian).
// ---------------------------------------------------------------------------

const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION = 20;
/** Fixed DOS date = 1980-01-01, time = 00:00:00 → deterministic output. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

interface PreparedEntry {
  nameBytes: Uint8Array;
  method: number;
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Build a DEFLATE ZIP archive from `entries`, placed at the archive root in the
 * given order. Each entry is deflate-compressed on the threadpool; entries that
 * do not shrink are stored uncompressed (STORE) so output never exceeds input.
 */
export async function writeDeflateZip(entries: ZipEntryInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();

  // Compress every entry (concurrently — each deflateRaw runs on the libuv
  // threadpool). Fall back to STORE when DEFLATE would not shrink the entry.
  const prepared: PreparedEntry[] = await Promise.all(
    entries.map(async (entry): Promise<Omit<PreparedEntry, 'localHeaderOffset'>> => {
      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      const deflated = new Uint8Array(await deflateRaw(entry.data));
      const useStore = deflated.length >= entry.data.length;
      return {
        nameBytes,
        method: useStore ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE,
        crc,
        compressed: useStore ? entry.data : deflated,
        uncompressedSize: entry.data.length,
      };
    }),
  ).then((rows) => rows.map((r) => ({ ...r, localHeaderOffset: 0 })));

  // Local file headers + data.
  const localChunks: Uint8Array[] = [];
  let offset = 0;
  for (const e of prepared) {
    e.localHeaderOffset = offset;
    const header = new Uint8Array(30 + e.nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, ZIP_VERSION, true); // version needed
    dv.setUint16(6, 0, true); // general purpose flags
    dv.setUint16(8, e.method, true);
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, e.crc, true);
    dv.setUint32(18, e.compressed.length, true); // compressed size
    dv.setUint32(22, e.uncompressedSize, true);
    dv.setUint16(26, e.nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra field length
    header.set(e.nameBytes, 30);
    localChunks.push(header, e.compressed);
    offset += header.length + e.compressed.length;
  }

  // Central directory.
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const e of prepared) {
    const rec = new Uint8Array(46 + e.nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0x02014b50, true); // central dir header signature
    dv.setUint16(4, ZIP_VERSION, true); // version made by
    dv.setUint16(6, ZIP_VERSION, true); // version needed
    dv.setUint16(8, 0, true); // flags
    dv.setUint16(10, e.method, true);
    dv.setUint16(12, DOS_TIME, true);
    dv.setUint16(14, DOS_DATE, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.compressed.length, true);
    dv.setUint32(24, e.uncompressedSize, true);
    dv.setUint16(28, e.nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra len
    dv.setUint16(32, 0, true); // comment len
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, e.localHeaderOffset, true);
    rec.set(e.nameBytes, 46);
    centralChunks.push(rec);
    centralSize += rec.length;
  }
  const centralOffset = offset;

  // End of central directory record.
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // this disk
  edv.setUint16(6, 0, true); // disk with central dir
  edv.setUint16(8, prepared.length, true); // records this disk
  edv.setUint16(10, prepared.length, true); // total records
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true); // comment length

  // Concatenate.
  const total =
    offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}
