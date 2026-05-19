/**
 * loadBundle — orchestrates unzip + per-session parse into a typed Bundle.
 *
 * PRD §5.1, §5.3, §4.6.
 *
 * Steps:
 *   1. Unzip → BundleFiles (or LoaderError).
 *   2. Parse sessions in parallel (order-independent per CLAUDE.md rule on Promise.all).
 *   3. Sort sessions by firstEvent.wall ascending.
 *   4. Validate manifest JSON shape via log-core's validateBundleManifestShape.
 *   5. Return Bundle.
 *
 * NOTE: signature verification is NOT done here — that is Phase 2
 * (validation/verify-manifest-sig.ts). The loader checks structure only.
 */

import { validateBundleManifestShape, ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';
import { unzipBundle } from './unzip.js';
import { parseSession } from './parse-session.js';
import type { Bundle, LoaderError, SessionParseError } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a bundle ZIP into a fully typed Bundle.
 *
 * @param input           A Blob or ArrayBuffer containing the ZIP bytes.
 * @param sourceFilename  The original filename (e.g. "hw1-bundle-2026-05-19.zip").
 * @param nowFn           Injectable clock for `loadedAt` — defaults to Date.
 *                        Inject a fixed value in tests to get deterministic output.
 */
export async function loadBundle(
  input: Blob | ArrayBuffer,
  sourceFilename: string,
  nowFn: () => string = () => new Date().toISOString(),
): Promise<Result<Bundle, LoaderError | SessionParseError>> {
  // ---------------------------------------------------------------------------
  // Step 1: Unzip.
  // ---------------------------------------------------------------------------
  const unzipResult = await unzipBundle(input);
  if (!unzipResult.ok) {
    return unzipResult;
  }

  const { manifestJson, manifestSigHex, sessions: sessionFiles } = unzipResult.value;

  // ---------------------------------------------------------------------------
  // Step 2: Validate the manifest JSON shape.
  //
  // Do this before parsing sessions so a malformed manifest fails fast.
  // ---------------------------------------------------------------------------
  let parsedManifestRaw: unknown;
  try {
    parsedManifestRaw = JSON.parse(manifestJson);
  } catch (e) {
    // manifest.json is not valid JSON — treat as a loader-level failure.
    // We re-use `unexpected_file` isn't right; the closest fit is missing_manifest
    // is wrong too. We surface this as a LoaderError with kind 'missing_manifest'
    // carrying a detail. Actually we can use 'unexpected_file' with the manifest
    // filename since the content is malformed, but that's confusing.
    //
    // The spec doesn't enumerate a `manifest_invalid_json` variant. The cleanest
    // mapping is to surface it as a SessionParseError `meta_invalid_shape` applied
    // at the manifest level — but that conflates levels.
    //
    // Decision: propagate as a LoaderError `not_a_zip` with a clear detail, since
    // a ZIP whose manifest.json is unparseable is as invalid as a non-ZIP. This is
    // the least surprising for callers: any load failure short-circuits via LoaderError.
    return err({
      kind: 'not_a_zip',
      detail: `manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const manifestResult = validateBundleManifestShape(parsedManifestRaw);
  if (!manifestResult.ok) {
    const me = manifestResult.error;
    const detail =
      me.kind === 'not_object'
        ? 'not_object'
        : me.kind === 'wrong_version'
          ? `wrong_version: ${String(me.actual)}`
          : me.kind === 'missing_field'
            ? `missing_field: ${me.field}`
            : `invalid_field: ${me.field} — ${me.reason}`;
    // Surface manifest shape errors as `not_a_zip` with detail: the ZIP is structurally
    // invalid from the loader's perspective if the manifest doesn't conform to spec.
    return err({ kind: 'not_a_zip', detail: `manifest.json shape invalid: ${detail}` });
  }

  const manifest = manifestResult.value;

  // ---------------------------------------------------------------------------
  // Step 3: Parse all sessions in parallel (they are order-independent).
  //
  // CLAUDE.md: "No Promise.all over operations that must be ordered."
  // Session parses are NOT ordered — each .slog is self-contained. The sort
  // in step 4 imposes the final order.
  // ---------------------------------------------------------------------------
  const sessionResults = await Promise.all(
    sessionFiles.map(({ slogText, metaJson }) => parseSession(slogText, metaJson)),
  );

  // Collect results — fail fast on the first error.
  const parsedSessions = [];
  for (const result of sessionResults) {
    if (!result.ok) {
      return result;
    }
    parsedSessions.push(result.value);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Sort sessions oldest → newest by firstEvent.wall.
  //
  // NOTE: `wall` is on the HashedEnvelope top level, not inside `data`.
  // `SessionStartPayload` has no `wall` field; the envelope itself does.
  // ---------------------------------------------------------------------------
  parsedSessions.sort(
    (a, b) => new Date(a.firstEvent.wall).getTime() - new Date(b.firstEvent.wall).getTime(),
  );

  return ok({
    manifest,
    manifestSigHex,
    sessions: parsedSessions,
    sourceFilename,
    loadedAt: nowFn(),
  });
}
