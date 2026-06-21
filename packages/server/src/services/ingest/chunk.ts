/**
 * Split `items` into consecutive sub-arrays of at most `size` elements.
 *
 * Used by the multipart ingest route to keep bulk `INSERT ... VALUES (...)`
 * statements under Postgres's 65535 bind-parameter ceiling: each ingest_files
 * row binds ~6 params, so a batch near the high end of INGEST_MAX_BATCH_FILES
 * (admin-raisable above the ~10.9k-row single-statement limit) must be inserted
 * in chunks. See `materialize-events.ts` for the same ceiling documented on the
 * events insert.
 *
 * `size` must be a positive integer. An empty input yields `[]`; an exact
 * multiple yields no trailing empty chunk.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk: size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
