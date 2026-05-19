/**
 * MetaWriter — owns the in-memory SlogMeta and atomic-writes the .slog.meta file.
 *
 * PRD §4.6: "A companion session-<uuid>.slog.meta file holds:
 *   - the session UUID
 *   - a per-session ephemeral signing keypair (private key encrypted …)
 *   - the chain of seq → hash checkpoints, signed every N events"
 *
 * CLAUDE.md: "Atomic writes. Write-temp-then-rename. Never partial-write the live log file."
 *
 * Design:
 * - MetaWriter is a class because it owns mutable in-memory state (the checkpoint list)
 *   and a persistent file path.
 * - appendCheckpoint serializes the entire SlogMeta to JSON (via canonicalize, for
 *   JCS stability) and atomic-writes the meta file after each checkpoint.
 * - dispose() is a no-op for symmetry with SessionWriter. The meta file is already
 *   on disk after each appendCheckpoint call.
 */

import { canonicalize } from '@provenance/log-core';
import type { SlogMeta } from '@provenance/log-core';
import type { EncryptedPrivkey } from '../crypto/session-keys.js';
import type { Checkpoint } from '../crypto/checkpoint-signer.js';
import { atomicWriteFile } from './atomic-write.js';
import type { AtomicWriteFs } from './atomic-write.js';

// ---------------------------------------------------------------------------
// MetaWriter
// ---------------------------------------------------------------------------

export class MetaWriter {
  private readonly metaPath: string;
  private readonly meta: SlogMeta;
  private readonly _fs: AtomicWriteFs | undefined;

  private constructor(metaPath: string, meta: SlogMeta, _fs?: AtomicWriteFs) {
    this.metaPath = metaPath;
    this.meta = meta;
    this._fs = _fs;
  }

  /**
   * Create a MetaWriter, write the initial meta file to disk, and return it.
   *
   * Writes the file immediately so the meta exists on disk from session start —
   * even before the first checkpoint — containing the session pubkey and
   * encrypted private key.
   */
  static async create(args: {
    metaPath: string;
    sessionId: string;
    sessionPubkeyHex: string;
    encryptedPrivkey: EncryptedPrivkey;
    /** Injectable fs for testing atomic-write failure paths. */
    _fs?: AtomicWriteFs;
  }): Promise<MetaWriter> {
    const { metaPath, sessionId, sessionPubkeyHex, encryptedPrivkey, _fs } = args;

    const meta: SlogMeta = {
      format_version: '1.0',
      session_id: sessionId,
      session_pubkey: sessionPubkeyHex,
      encrypted_session_privkey: encryptedPrivkey,
      checkpoints: [],
    };

    const writer = new MetaWriter(metaPath, meta, _fs);
    await writer._write();
    return writer;
  }

  /**
   * Append a checkpoint to the in-memory list and atomic-write the meta file.
   */
  async appendCheckpoint(cp: Checkpoint): Promise<void> {
    // SlogMeta.checkpoints is ReadonlyArray — we hold the mutable version at runtime.
    (this.meta.checkpoints as Checkpoint[]).push(cp);
    await this._write();
  }

  /**
   * Async no-op. The meta file is already up-to-date after each appendCheckpoint.
   * Provided for symmetry with SessionWriter so callers can treat both uniformly.
   */
  async dispose(): Promise<void> {
    // No-op — meta is already persisted.
  }

  /**
   * Serialize the current meta to JCS canonical JSON and atomic-write to disk.
   */
  private async _write(): Promise<void> {
    const json = canonicalize(this.meta);
    if (this._fs !== undefined) {
      await atomicWriteFile(this.metaPath, json, this._fs);
    } else {
      await atomicWriteFile(this.metaPath, json);
    }
  }
}
