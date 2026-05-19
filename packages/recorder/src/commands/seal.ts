/**
 * Bundle seal command.
 *
 * PRD §4.6 (seal operation), §5.3 (bundle = ZIP of .provenance/), §5.4 (feeds checks 1-6),
 * §6 (extension_hash in manifest).
 *
 * Produces:
 *   .provenance/manifest.json   — BundleManifest (atomically written)
 *   .provenance/manifest.sig    — hex ed25519 signature over canonical manifest JSON (atomic)
 *   <outputDir>/<id>-bundle-<ts>.zip — ZIP of the full .provenance/ directory
 *
 * The signature covers the JCS-canonical bytes of manifest.json. The Analyzer verifies by:
 *   1. Reading manifest.json → canonicalize → verify sig against session_pubkey from session.start.
 *
 * Design notes:
 *   - chain_broken is returned on the FIRST broken session; we never seal a partial bundle.
 *   - meta files are optional: if a .slog.meta doesn't exist, meta_sha256 is the sha256 of
 *     an empty byte sequence (caller is responsible for always writing the meta in Phase 9;
 *     this is a defensive fallback, not a design choice).
 *   - The ZIP includes ALL files in provenanceDir (slog + meta + manifest + sig).
 *   - Atomic writes for manifest.json and manifest.sig prevent partial state.
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseEntries, validateChain, canonicalize, sha256Hex } from '@provenance/log-core';
import type { BundleManifest } from '@provenance/log-core';
import { atomicWriteFile } from '../io/atomic-write.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SealResult =
  | { kind: 'ok'; bundlePath: string; manifestSha256: string }
  | { kind: 'no_sessions' }
  | { kind: 'chain_broken'; sessionId: string; reason: string }
  | { kind: 'write_error'; message: string };

export type SealDeps = {
  /** Workspace folder (for output path + .provenance/ location). */
  workspaceFolder: vscode.WorkspaceFolder;
  /** Path to .provenance/ (allows override in tests). */
  provenanceDir: string;
  /** Assignment id + semester from the loaded manifest. */
  assignmentId: string;
  semester: string;
  /** Active session private key for signing the bundle manifest. 32 bytes. */
  sessionPrivkey: Uint8Array;
  /** Active session public key, hex. */
  sessionPubkeyHex: string;
  /** Computes a sha256 of the recorder's own dist/ directory. */
  computeExtensionHash: () => Promise<string>;
  /** Output directory for the resulting .zip. Defaults to workspaceFolder.uri.fsPath. */
  outputDir?: string;
  /** Now (for the zip filename timestamp). */
  now: () => Date;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute sha256 of file bytes at the given path.
 * If the file doesn't exist, returns sha256 of empty bytes (defensive fallback).
 */
async function sha256OfFile(filePath: string): Promise<string> {
  try {
    const bytes = await fsPromises.readFile(filePath);
    const hash = createHash('sha256');
    hash.update(bytes);
    return hash.digest('hex');
  } catch {
    // File doesn't exist or can't be read — return sha256('') as a stable fallback.
    return sha256Hex('');
  }
}

/**
 * Extract session_id and prev_session_id from the first entry of a parsed slog.
 * Returns null if the first entry isn't a session.start or data is malformed.
 */
function extractSessionIds(
  entries: readonly import('@provenance/log-core').HashedEnvelope[],
): { session_id: string; prev_session_id: string | null } | null {
  const first = entries[0];
  if (first === undefined || first.kind !== 'session.start') {
    return null;
  }
  const data = first.data as Record<string, unknown>;
  const session_id = typeof data['session_id'] === 'string' ? data['session_id'] : null;
  if (session_id === null) {
    return null;
  }
  const prev_session_id =
    typeof data['prev_session_id'] === 'string' ? data['prev_session_id'] : null;
  return { session_id, prev_session_id };
}

/**
 * ISO timestamp formatted for use in filenames: colons replaced with dashes.
 * E.g. "2026-05-19T14-30-00.000Z"
 */
function filenameTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// sealBundle
// ---------------------------------------------------------------------------

/**
 * Produce a submission-ready ZIP bundle from the .provenance/ directory.
 *
 * Step-by-step:
 *   1. List .slog files. None → no_sessions.
 *   2. For each .slog: parse + validate chain. Broken → chain_broken (abort).
 *      Collect: session_id, prev_session_id, slog_sha256, meta_sha256.
 *   3. Build BundleManifest.
 *   4. Canonicalize + sign → atomic-write manifest.json and manifest.sig.
 *   5. ZIP all files in provenanceDir (including new manifest + sig).
 *   6. Write ZIP to outputDir. Return ok with bundlePath and manifestSha256.
 */
export async function sealBundle(deps: SealDeps): Promise<SealResult> {
  const {
    workspaceFolder,
    provenanceDir,
    assignmentId,
    semester,
    sessionPrivkey,
    computeExtensionHash: getExtensionHash,
    outputDir,
    now,
  } = deps;

  // Step 1: List .slog files.
  let allEntries: string[];
  try {
    allEntries = await fsPromises.readdir(provenanceDir);
  } catch {
    // Directory doesn't exist → no sessions.
    return { kind: 'no_sessions' };
  }

  const slogFiles = allEntries.filter((f) => f.endsWith('.slog') && !f.endsWith('.slog.meta'));
  if (slogFiles.length === 0) {
    return { kind: 'no_sessions' };
  }

  // Step 2: Parse and validate each .slog.
  const sessionEntries: BundleManifest['sessions'][number][] = [];

  for (const filename of slogFiles.sort()) {
    const slogPath = path.join(provenanceDir, filename);
    const metaPath = `${slogPath}.meta`;

    // Read and parse the .slog.
    let slogText: string;
    try {
      slogText = await fsPromises.readFile(slogPath, 'utf8');
    } catch (e) {
      return {
        kind: 'write_error',
        message: `Failed to read ${filename}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const parseResult = parseEntries(slogText);
    if (!parseResult.ok) {
      // Malformed slog — treat as a broken chain. Use filename as fallback session id.
      return {
        kind: 'chain_broken',
        sessionId: filename,
        reason: `parse error on line ${parseResult.error.kind === 'invalid_json' ? parseResult.error.line : parseResult.error.line}: ${parseResult.error.kind}`,
      };
    }

    const entries = parseResult.value;

    // Validate the chain.
    const chainResult = validateChain(entries);
    if (!chainResult.ok) {
      const sessionIds = extractSessionIds(entries);
      return {
        kind: 'chain_broken',
        sessionId: sessionIds?.session_id ?? filename,
        reason: chainResult.break.reason,
      };
    }

    // Extract session IDs.
    const ids = extractSessionIds(entries);
    if (ids === null) {
      return {
        kind: 'chain_broken',
        sessionId: filename,
        reason: 'missing or malformed session.start entry',
      };
    }

    // Compute file hashes.
    const slogSha256 = await sha256OfFile(slogPath);
    const metaSha256 = await sha256OfFile(metaPath);

    sessionEntries.push({
      session_id: ids.session_id,
      prev_session_id: ids.prev_session_id,
      slog_sha256: slogSha256,
      meta_sha256: metaSha256,
    });
  }

  // Step 3: Build BundleManifest.
  let extensionHash: string;
  try {
    extensionHash = await getExtensionHash();
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to compute extension hash: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const manifest: BundleManifest = {
    format_version: '1.0',
    assignment_id: assignmentId,
    semester,
    extension_hash: extensionHash,
    sessions: sessionEntries,
  };

  // Step 4: Canonicalize + sign + atomic-write manifest.json and manifest.sig.
  const manifestPath = path.join(provenanceDir, 'manifest.json');
  const sigPath = path.join(provenanceDir, 'manifest.sig');

  const canonicalManifest = canonicalize(manifest);
  const canonicalBytes = new TextEncoder().encode(canonicalManifest);

  let sigBytes: Uint8Array;
  try {
    sigBytes = await ed.signAsync(canonicalBytes, sessionPrivkey);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to sign manifest: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const sigHex = bytesToHex(sigBytes);

  try {
    // Atomic write for manifest.json (write full canonical JSON, not the manifest object,
    // so what's on disk is exactly what was signed).
    await atomicWriteFile(manifestPath, canonicalManifest);
    await atomicWriteFile(sigPath, sigHex);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to write manifest/sig: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Compute manifest SHA-256 for the return value.
  const manifestSha256 = sha256Hex(canonicalBytes);

  // Step 5: ZIP all files in provenanceDir.
  let dirEntries: string[];
  try {
    dirEntries = await fsPromises.readdir(provenanceDir);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to read provenance dir: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const zip = new JSZip();

  for (const filename of dirEntries) {
    // Skip quarantine files and temp files.
    if (filename.includes('.corrupt-') || filename.endsWith('.tmp')) {
      continue;
    }
    const filePath = path.join(provenanceDir, filename);
    try {
      const fileBytes = await fsPromises.readFile(filePath);
      zip.file(filename, fileBytes);
    } catch {
      // File disappeared between readdir and readFile — skip it.
    }
  }

  let zipBytes: Uint8Array;
  try {
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    zipBytes = new Uint8Array(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to generate ZIP: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Step 6: Write the ZIP.
  const ts = filenameTimestamp(now());
  const zipFilename = `${assignmentId}-bundle-${ts}.zip`;
  const resolvedOutputDir = outputDir ?? workspaceFolder.uri.fsPath;
  const bundlePath = path.join(resolvedOutputDir, zipFilename);

  try {
    await fsPromises.writeFile(bundlePath, zipBytes);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to write bundle ZIP: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { kind: 'ok', bundlePath, manifestSha256 };
}

// ---------------------------------------------------------------------------
// Verify manifest signature (used by tests and the future Analyzer)
// ---------------------------------------------------------------------------

/**
 * Verify a bundle manifest signature.
 *
 * @param canonicalManifestJson  The exact canonical JSON string that was signed.
 * @param sigHex                 Hex-encoded ed25519 signature.
 * @param pubkeyHex              Hex-encoded ed25519 public key.
 * @returns true if the signature is valid.
 */
export async function verifyManifestSig(
  canonicalManifestJson: string,
  sigHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  try {
    const msgBytes = new TextEncoder().encode(canonicalManifestJson);
    const sig = hexToBytes(sigHex);
    const pubkey = hexToBytes(pubkeyHex);
    return await ed.verifyAsync(sig, msgBytes, pubkey);
  } catch {
    return false;
  }
}
