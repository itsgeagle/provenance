/**
 * Reads and verifies the manifest file from a workspace folder. The file is named
 * `.provenance-manifest` (canonical) or `provenance-manifest`.
 * PRD §4.1: "If the signature doesn't verify, the extension does nothing."
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { parseManifest, verifyManifest } from '@provenance/log-core';
import type { Manifest, Result } from '@provenance/log-core';
import { COURSE_PUBLIC_KEY_HEX } from './course-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivationError =
  | { kind: 'no_workspace' }
  | { kind: 'no_manifest_file' }
  | { kind: 'manifest_read_error'; message: string }
  | { kind: 'manifest_parse_error'; detail: unknown }
  | { kind: 'manifest_signature_invalid' };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Candidate manifest file names, in precedence order. The dotfile form is the
 * canonical name; the plain form is accepted for workspaces (e.g. some archive
 * tools or platforms) that drop or hide leading-dot files.
 */
export const MANIFEST_FILE_NAMES = ['.provenance-manifest', 'provenance-manifest'] as const;

/**
 * Read, parse, and cryptographically verify the manifest file in the given workspace folder.
 * Accepts either `.provenance-manifest` (canonical) or `provenance-manifest`, preferring the
 * former when both are present.
 *
 * @param workspaceFolder  The workspace folder (or folder-like directory) to look in.
 * @param pubkeyHex        Optional override for the course public key (used in tests).
 *                         Defaults to COURSE_PUBLIC_KEY_HEX.
 *
 * On any error, returns a Result<never, ActivationError> describing what went wrong.
 * Callers should silently exit on any error (PRD §4.1).
 */
/** Minimal structural type — a vscode.WorkspaceFolder already satisfies this. */
export type FolderLike = { uri: { fsPath: string } };

export async function loadAndVerifyManifest(
  workspaceFolder: FolderLike,
  pubkeyHex: string = COURSE_PUBLIC_KEY_HEX,
): Promise<Result<Manifest, ActivationError>> {
  // Step 1: Read the file. Try each candidate name in precedence order; only
  // treat the manifest as missing if none of them exist.
  let rawText: string | undefined;
  for (const fileName of MANIFEST_FILE_NAMES) {
    const manifestFilePath = path.join(workspaceFolder.uri.fsPath, fileName);
    try {
      rawText = await fsPromises.readFile(manifestFilePath, 'utf8');
      break;
    } catch (e) {
      const isNotFound =
        e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { kind: 'manifest_read_error', message } };
    }
  }

  if (rawText === undefined) {
    return { ok: false, error: { kind: 'no_manifest_file' } };
  }

  // Step 2: Parse JSON + validate shape.
  const parseResult = parseManifest(rawText);
  if (!parseResult.ok) {
    return { ok: false, error: { kind: 'manifest_parse_error', detail: parseResult.error } };
  }

  // Step 3: Verify ed25519 signature against the course public key.
  const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
  if (!verifyResult.ok) {
    return { ok: false, error: { kind: 'manifest_signature_invalid' } };
  }

  return { ok: true, value: parseResult.value };
}
