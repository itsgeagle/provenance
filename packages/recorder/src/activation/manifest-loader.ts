/**
 * Reads and verifies the .provenance-manifest file from a workspace folder.
 * PRD §4.1: "If the signature doesn't verify, the extension does nothing."
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { parseManifest, verifyManifest } from '@provenance/log-core';
import type { Cs61aManifest, Result } from '@provenance/log-core';
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
 * Read, parse, and cryptographically verify the .provenance-manifest file in the given workspace folder.
 *
 * @param workspaceFolder  The VS Code workspace folder to look in.
 * @param pubkeyHex        Optional override for the course public key (used in tests).
 *                         Defaults to COURSE_PUBLIC_KEY_HEX.
 *
 * On any error, returns a Result<never, ActivationError> describing what went wrong.
 * Callers should silently exit on any error (PRD §4.1).
 */
export async function loadAndVerifyManifest(
  workspaceFolder: vscode.WorkspaceFolder,
  pubkeyHex: string = COURSE_PUBLIC_KEY_HEX,
): Promise<Result<Cs61aManifest, ActivationError>> {
  const manifestFilePath = path.join(workspaceFolder.uri.fsPath, '.provenance-manifest');

  // Step 1: Read the file.
  let rawText: string;
  try {
    rawText = await fsPromises.readFile(manifestFilePath, 'utf8');
  } catch (e) {
    const isNotFound =
      e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      return { ok: false, error: { kind: 'no_manifest_file' } };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { kind: 'manifest_read_error', message } };
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
