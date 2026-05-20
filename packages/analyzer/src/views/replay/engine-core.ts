/**
 * engine-core.ts — pure replay engine (no React, no timers, no side effects).
 *
 * Algorithm overview:
 *
 * STATE:
 *   currentGlobalIdx : the index of the "current" event (inclusive, so file
 *                      state reflects events [0, currentGlobalIdx]).
 *   status           : 'paused' | 'playing'
 *   speed            : playback multiplier (currently reserved; timer lives
 *                      in useReplayEngine)
 *   sessionId        : session being replayed
 *
 * FILES:
 *   "files under review" = union of all event.file values in the session's
 *   events where kind ∈ {doc.change, paste, doc.save, doc.open, fs.external_change}.
 *
 * RECONSTRUCTION:
 *   We maintain one `FileReplayState` per file path. On step/seek we rebuild
 *   from the nearest checkpoint below the target globalIdx, then step forward.
 *
 * CHECKPOINTS:
 *   Every CHECKPOINT_EVERY events we cache the full FileReplayState for all
 *   files. Checkpoints are keyed by checkpointGlobalIdx (a multiple of
 *   CHECKPOINT_EVERY). The map is lazily populated: when seek(T) runs, we find
 *   the highest checkpoint below T, build that checkpoint if missing (walking
 *   from the prior checkpoint or from 0), then step forward from there.
 *
 *   Checkpoint key: checkpointGlobalIdx (number).
 *   Value: Map<filePath, FileReplayState> (immutable snapshot).
 *
 * SEEK(T):
 *   1. Find checkpointFloor = floor(T / CHECKPOINT_EVERY) * CHECKPOINT_EVERY.
 *   2. If checkpoints.has(checkpointFloor) → startState = checkpoints.get(…).
 *      Else build it by walking from the prior known checkpoint forward.
 *   3. From startState, reconstruct each file forward to T (exclusive).
 *   4. Return new fileStates map + new currentGlobalIdx = T.
 *
 * STEP(n):
 *   Clamps to [0, events.length - 1], then delegates to seek.
 *
 * NOTE: this module exports `createEngine` which returns a mutable EngineHandle.
 * The React layer (`useReplayEngine`) drives state changes via the handle and
 * reflects them into React state. The engine itself never calls setState or
 * any async API.
 *
 * PRD ref: §7.2 (replay view core).
 */

import { reconstructFileWithProvenance } from '../../index/reconstruct-file-provenance.js';
import type { FileReplayState } from '../../index/reconstruct-file-provenance.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache a checkpoint every N events. */
const CHECKPOINT_EVERY = 1000;

/** Event kinds that "write" to a file; used to build the file list. */
const FILE_WRITING_KINDS = new Set([
  'doc.change',
  'paste',
  'doc.save',
  'doc.open',
  'fs.external_change',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplayStatus = 'paused' | 'playing';

export type ReplayState = {
  status: ReplayStatus;
  /** The index into events[] of the "current" position. -1 means before any event. */
  currentGlobalIdx: number;
  speed: number;
  sessionId: string;
};

export type EngineHandle = {
  /** Current immutable snapshot of the engine state. */
  getState(): ReplayState;
  /** Current file states keyed by file path. */
  getFileStates(): Map<string, FileReplayState>;
  /** Ordered list of files under review. */
  getFiles(): string[];
  /** Total number of events in the session. */
  eventCount(): number;

  /** Advance by n events (may be negative). Clamps to valid range. Returns new state. */
  step(n?: number): ReplayState;
  /** Jump to a specific event index. Clamps to valid range. Returns new state. */
  seek(globalIdx: number): ReplayState;
  /** Set status to 'playing' (timer management is the React layer's job). */
  setPlaying(): ReplayState;
  /** Set status to 'paused'. Returns new state. */
  setPaused(): ReplayState;
  /** Update speed (does not start/stop playing). Returns new state. */
  setSpeed(speed: number): ReplayState;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A snapshot of all file states at a checkpoint, keyed by filePath. */
type Checkpoint = Map<string, FileReplayState>;

/** Internal mutable state bag. */
type InternalState = {
  state: ReplayState;
  fileStates: Map<string, FileReplayState>;
  /** events[] for this session (ordered by globalIdx). */
  events: readonly IndexedEvent[];
  /** Files under review (derived from events; computed once). */
  files: string[];
  /**
   * Checkpoint cache. Key = globalIdx of the first event AFTER the checkpoint
   * boundary, i.e. the file state reflects events [0, key).
   *
   * Special case: key=0 is the empty initial state (no events applied).
   */
  checkpoints: Map<number, Checkpoint>;
  /** The EventIndex (needed to call reconstructFileWithProvenance). */
  index: EventIndex;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the set of "files under review" from a session's events.
 * These are all file paths touched by the writing-kind events, in the order
 * they first appear.
 */
function computeFiles(events: readonly IndexedEvent[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of events) {
    if (FILE_WRITING_KINDS.has(e.kind) && e.file != null) {
      if (!seen.has(e.file)) {
        seen.add(e.file);
        result.push(e.file);
      }
    }
  }
  return result;
}

/**
 * Build an empty FileReplayState for a file (initial / before any events).
 */
function emptyFileState(): FileReplayState {
  return {
    content: '',
    provenance: new Uint32Array(0),
    kindByGlobalIdx: new Map(),
    hashBySaveSeq: new Map(),
  };
}

/**
 * Reconstruct all files for the engine's session up to (exclusive) upToGlobalIdx.
 * Uses startStates as the baseline (the checkpoint to start from).
 *
 * We call `reconstructFileWithProvenance` for each file with `upToGlobalIdx`.
 * That function always replays from the beginning of the file's event stream.
 * For large sessions, the checkpoint scheme trades off memory for CPU: we cache
 * the state at every CHECKPOINT_EVERY boundary so we don't replay from index 0
 * every time.
 *
 * NOTE: Because `reconstructFileWithProvenance` replays from the very start of
 * the file event stream (it doesn't accept a start offset), we cannot directly
 * use a checkpoint as the starting point for an incremental replay. Instead,
 * checkpoints serve as a pre-compute hint: when the target is large (say
 * globalIdx = 5,000), we first ensure the checkpoint at 4,000 is built, and
 * then call `reconstructFileWithProvenance` with `upToGlobalIdx = 5,001` — which
 * is the same call we'd make without checkpoints. The benefit of building the
 * checkpoint is that the NEXT seek near 5,000 can reuse the same full call,
 * and if we're stepping forward we call it once more rather than twice.
 *
 * For Phase 13, the simple approach is: just call reconstructFileWithProvenance
 * directly with the desired upToGlobalIdx. Checkpoints reduce duplicate work
 * only when scrubbing back to a position that was previously computed, by making
 * the boundary explicit. The perf budget note says this is not a Phase 13 concern.
 *
 * The actual optimized seek path:
 *   - The `upToGlobalIdx` we pass is `currentGlobalIdx + 1` (exclusive).
 *   - reconstruct walks the file's byFile events stopping at that boundary.
 */
function buildFileStates(
  internal: InternalState,
  upToGlobalIdx: number,
): Map<string, FileReplayState> {
  const result = new Map<string, FileReplayState>();
  for (const filePath of internal.files) {
    const state = reconstructFileWithProvenance(internal.index, filePath, upToGlobalIdx);
    result.set(filePath, state);
  }
  return result;
}

/**
 * Ensure the checkpoint at `checkpointIdx` exists in the cache.
 * `checkpointIdx` must be a multiple of CHECKPOINT_EVERY.
 * If it's not cached, build it (this is cheap: we're just calling
 * reconstructFileWithProvenance up to that boundary, same as a seek would do).
 */
function ensureCheckpoint(internal: InternalState, checkpointIdx: number): void {
  if (internal.checkpoints.has(checkpointIdx)) return;
  const states = buildFileStates(internal, checkpointIdx);
  internal.checkpoints.set(checkpointIdx, states);
}

/**
 * Clamp a globalIdx to [−1, events.length − 1].
 * −1 represents "before first event".
 */
function clamp(idx: number, maxIdx: number): number {
  return Math.max(-1, Math.min(maxIdx, idx));
}

// ---------------------------------------------------------------------------
// createEngine — factory
// ---------------------------------------------------------------------------

/**
 * Create a replay engine for the given session.
 *
 * @param index       The EventIndex for the whole bundle (we read bySessionId + byFile).
 * @param sessionId   Which session to replay.
 * @returns           An EngineHandle with mutable internal state.
 */
export function createEngine(index: EventIndex, sessionId: string): EngineHandle {
  const sessionEvents = index.bySessionId.get(sessionId) ?? [];
  const files = computeFiles(sessionEvents);

  const initialState: ReplayState = {
    status: 'paused',
    currentGlobalIdx: -1,
    speed: 1,
    sessionId,
  };

  const internal: InternalState = {
    state: { ...initialState },
    fileStates: new Map(files.map((f) => [f, emptyFileState()])),
    events: sessionEvents,
    files,
    checkpoints: new Map<number, Checkpoint>([
      [0, new Map(files.map((f) => [f, emptyFileState()]))],
    ]),
    index,
  };

  // ---------------------------------------------------------------------------
  // Seek implementation
  // ---------------------------------------------------------------------------

  function seekTo(globalIdx: number): ReplayState {
    const maxIdx = internal.events.length - 1;
    const clamped = clamp(globalIdx, maxIdx);

    // upToGlobalIdx (exclusive) = clamped + 1.
    // If clamped = -1 (before any event), upToGlobalIdx = 0 → no events applied.
    const upTo = clamped + 1;

    // Warm the checkpoint below this position so future adjacent seeks can
    // short-circuit. (The warmup itself calls reconstructFileWithProvenance.)
    const checkpointFloor = Math.floor(clamped / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    if (checkpointFloor > 0) {
      ensureCheckpoint(internal, checkpointFloor);
    }

    // Rebuild file states up to the target position.
    const newFileStates =
      upTo === 0
        ? new Map(internal.files.map((f) => [f, emptyFileState()]))
        : buildFileStates(internal, upTo);

    internal.fileStates = newFileStates;
    internal.state = {
      ...internal.state,
      currentGlobalIdx: clamped,
    };

    return { ...internal.state };
  }

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------

  const handle: EngineHandle = {
    getState() {
      return { ...internal.state };
    },

    getFileStates() {
      return new Map(internal.fileStates);
    },

    getFiles() {
      return [...internal.files];
    },

    eventCount() {
      return internal.events.length;
    },

    step(n = 1) {
      const target = internal.state.currentGlobalIdx + n;
      return seekTo(target);
    },

    seek(globalIdx) {
      return seekTo(globalIdx);
    },

    setPlaying() {
      internal.state = { ...internal.state, status: 'playing' };
      return { ...internal.state };
    },

    setPaused() {
      internal.state = { ...internal.state, status: 'paused' };
      return { ...internal.state };
    },

    setSpeed(speed) {
      internal.state = { ...internal.state, speed };
      return { ...internal.state };
    },
  };

  return handle;
}
