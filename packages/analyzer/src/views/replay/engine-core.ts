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

import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

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
  /**
   * The engine's current position in session time (ms since session start).
   * Tracks the virtual playhead for real-time rAF-based playback.
   * Synced to events[currentGlobalIdx].t on seek/step; advanced by tick().
   */
  virtualT: number;
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

  /**
   * Advance the virtual time pointer by `virtualDeltaMs` ms of session time.
   * Applies all events whose `t` falls in [currentVirtualT, currentVirtualT + virtualDeltaMs].
   * If no events fall in the window, just advances virtualT (sits through an idle gap).
   * Returns new state.
   */
  tick(virtualDeltaMs: number): ReplayState;

  /**
   * The t value of the last event in the session (or 0 if no events).
   * Used by the rAF loop to detect end-of-stream.
   */
  endVirtualT(): number;
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
  /**
   * Cursor into `events` as an array position (0-based), where -1 means
   * "before the first event". This is the engine's internal playhead.
   *
   * It is NOT the same as `state.currentGlobalIdx`: session events carry their
   * true whole-bundle `globalIdx`, which for any session after the first is far
   * larger than its array position. `state.currentGlobalIdx` is derived as
   * `events[pos].globalIdx` (or -1), so all consumers — and the whole-bundle
   * `reconstructFileWithProvenance` cut — see the true globalIdx, while
   * step/tick/scrub navigate by array position.
   */
  pos: number;
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
    virtualT: sessionEvents.length > 0 ? (sessionEvents[0]!.t ?? 0) : 0,
  };

  const internal: InternalState = {
    state: { ...initialState },
    fileStates: new Map(files.map((f) => [f, emptyFileState()])),
    pos: -1,
    events: sessionEvents,
    files,
    checkpoints: new Map<number, Checkpoint>([
      [0, new Map(files.map((f) => [f, emptyFileState()]))],
    ]),
    index,
  };

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  /** The true whole-bundle globalIdx of the event at array position `pos`. */
  function globalIdxAtPos(pos: number): number {
    return pos < 0 ? -1 : (internal.events[pos]?.globalIdx ?? -1);
  }

  /**
   * The array position whose event we should be "at" for a requested true
   * globalIdx `g`: the last session event with `globalIdx <= g`, or -1 when `g`
   * precedes the first event. Session events are ordered ascending by globalIdx,
   * so a linear scan suffices (and mirrors EventSidebar's globalIdx→listIdx scan).
   */
  function posForGlobalIdx(g: number): number {
    let pos = -1;
    for (let i = 0; i < internal.events.length; i++) {
      if (internal.events[i]!.globalIdx <= g) {
        pos = i;
      } else {
        break;
      }
    }
    return pos;
  }

  // ---------------------------------------------------------------------------
  // Seek implementation — navigate to array position `pos`.
  //
  // `pos` is a session-local array index (-1 = before any event). It is clamped
  // to [-1, events.length - 1]. Reconstruction is cut at the event's TRUE
  // globalIdx (+1, exclusive) because reconstructFileWithProvenance walks the
  // whole-bundle byFile stream; and `state.currentGlobalIdx` exposes that same
  // true globalIdx to all consumers.
  // ---------------------------------------------------------------------------

  function seekToPos(pos: number): ReplayState {
    const maxIdx = internal.events.length - 1;
    const clamped = clamp(pos, maxIdx);
    const globalIdx = globalIdxAtPos(clamped);

    // upToGlobalIdx (exclusive) = current event's true globalIdx + 1.
    // If clamped = -1 (before any event), upTo = 0 → no events applied.
    const upTo = clamped === -1 ? 0 : globalIdx + 1;

    // Warm the checkpoint below this position so future adjacent seeks can
    // short-circuit. Keyed by the true-globalIdx cut so the cache boundaries
    // align with the reconstruction the seek performs.
    const checkpointFloor = Math.floor(Math.max(0, upTo - 1) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    // Skip warmup for the implicit-empty checkpoint at 0.
    if (checkpointFloor >= CHECKPOINT_EVERY) {
      ensureCheckpoint(internal, checkpointFloor);
    }

    // Rebuild file states up to the target position.
    const newFileStates =
      upTo === 0
        ? new Map(internal.files.map((f) => [f, emptyFileState()]))
        : buildFileStates(internal, upTo);

    // Sync virtualT to the target event's t value.
    // At -1 (before any event), use the first event's t (or 0).
    const targetVirtualT =
      clamped === -1
        ? (internal.events[0]?.t ?? 0)
        : (internal.events[clamped]?.t ?? internal.state.virtualT);

    internal.pos = clamped;
    internal.fileStates = newFileStates;
    internal.state = {
      ...internal.state,
      currentGlobalIdx: globalIdx,
      virtualT: targetVirtualT,
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
      // Step by `n` events in the session (array-position space), not in
      // globalIdx space — the next event may be many globalIdx away.
      return seekToPos(internal.pos + n);
    },

    seek(globalIdx) {
      // `globalIdx` is a true whole-bundle index (sidebar rows, jump targets,
      // and the scrub slider all pass true globalIdx values). Map it onto the
      // session event it lands on.
      return seekToPos(posForGlobalIdx(globalIdx));
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

    tick(virtualDeltaMs) {
      if (internal.events.length === 0) {
        return { ...internal.state };
      }

      const newVirtualT = internal.state.virtualT + virtualDeltaMs;
      const currentIdx = internal.pos;
      const maxIdx = internal.events.length - 1;

      // If already at the end, just update virtualT.
      if (currentIdx >= maxIdx) {
        internal.state = { ...internal.state, virtualT: newVirtualT };
        return { ...internal.state };
      }

      // Find the last event whose t <= newVirtualT, starting after currentIdx.
      // All events with t in (currentVirtualT, newVirtualT] are applied.
      // Indices here are array positions into the session's events.
      let targetIdx = currentIdx;
      for (let i = currentIdx + 1; i <= maxIdx; i++) {
        const eventT = internal.events[i]!.t ?? 0;
        if (eventT <= newVirtualT) {
          targetIdx = i;
        } else {
          break;
        }
      }

      if (targetIdx !== currentIdx) {
        // We have new events to apply — seek to the last one in the window.
        // seekToPos also syncs virtualT to the event's t, but we want virtualT
        // to reflect the full advance (including idle time beyond the last
        // event). So we call seekToPos and then overwrite virtualT.
        seekToPos(targetIdx);
        internal.state = { ...internal.state, virtualT: newVirtualT };
      } else {
        // No events fell in the window (idle gap): just advance virtualT.
        internal.state = { ...internal.state, virtualT: newVirtualT };
      }

      return { ...internal.state };
    },

    endVirtualT() {
      if (internal.events.length === 0) return 0;
      return internal.events[internal.events.length - 1]!.t ?? 0;
    },
  };

  return handle;
}
