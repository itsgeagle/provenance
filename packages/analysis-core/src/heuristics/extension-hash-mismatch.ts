/**
 * extension_hash_mismatch heuristic (Phase 17).
 *
 * PRD §7.4 integrity: "The recorder's bundle manifest hash does not match any
 * known-good extension build."
 *
 * The recorder embeds a SHA-256 hash of its own installed file tree (e.g. the
 * VS Code recorder's `dist/`, walked and hashed by `commands/extension-hash.ts`)
 * in `bundle.manifest.extension_hash` at seal time. This allowlist lets the
 * analyzer verify that the submitted bundle was produced by an unmodified
 * recorder — a tampered recorder could suppress AI-tool usage signals. Hashing
 * a file tree rather than a packaged artifact (`.vsix`) lets a single allowlist
 * cover the VS Code, JetBrains, and Neovim recorders, each with its own build
 * output shape.
 *
 * Config: `config.extensionHashMismatch.knownGoodHashes` (defaults to the
 * committed `config/known-good-extension-hashes.json`). Course staff must
 * update this list each time a new recorder build is deployed.
 *
 * Severity: 'medium'. Confidence: 0.9.
 * (Mismatch could indicate a student compiled their own recorder, but could
 * also be a legitimate build they downloaded before the hash was updated.)
 *
 * One flag per bundle (not per session) — this is a bundle-level check.
 * The `supportingSeqs` list is empty (no specific event caused the mismatch;
 * it is a manifest-level property).
 *
 * PLACEHOLDER note: the shipped `known-good-extension-hashes.json` contains
 * a placeholder hash. Course staff MUST replace this before deployment. See
 * design decision A54 in .notes/analyzer-progress.md.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(_index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { knownGoodHashes } = config.extensionHashMismatch;
  const extensionHash = bundle.manifest.extension_hash;

  if (knownGoodHashes.includes(extensionHash)) return [];

  return [
    {
      id: `extension_hash_mismatch-${extensionHash.slice(0, 16)}`,
      heuristic: 'extension_hash_mismatch',
      title: 'Recorder extension hash not in known-good list',
      severity: 'medium',
      confidence: 0.9,
      supportingSeqs: [],
      description:
        `The recorder extension hash "${extensionHash}" is not in the course's ` +
        `known-good recorder hash list. This may indicate the student used a ` +
        `modified or unofficial version of the Provenance recorder extension. ` +
        `Course staff should verify the hash against the published release hashes.`,
      detail: {
        extensionHash,
        knownGoodHashCount: knownGoodHashes.length,
      },
    },
  ];
}

export const extensionHashMismatchHeuristic: Heuristic = {
  id: 'extension_hash_mismatch',
  label: 'Recorder extension hash mismatch',
  run,
};
