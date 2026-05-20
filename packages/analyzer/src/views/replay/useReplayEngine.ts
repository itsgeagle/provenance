/**
 * useReplayEngine — React adapter over the pure engine-core.
 *
 * Responsibilities:
 *  - Instantiates/re-instantiates the engine when (index, sessionId) changes.
 *  - Manages the playback rAF loop. CLAUDE.md rule: every timer/RAF
 *    has an explicit cleanup path.
 *  - Exposes `play`, `pause`, `step`, `seek` to React components.
 *  - Exposes reactive `state`, `fileStates`, `files` (via useState).
 *
 * Design choice: the engine handle is stored in a ref (not state) to avoid
 * re-creating it on every render. Only the *output* (ReplayState + fileStates)
 * is stored in state so React re-renders on meaningful changes.
 *
 * rAF loop contract:
 *  - `play(speed?)`: captures wall-clock t0 = performance.now(), schedules a
 *    requestAnimationFrame loop. Each frame: compute wallDelta since last frame,
 *    scale by speed to get virtualDelta, call engine.tick(virtualDelta).
 *    If engine.getVirtualT() >= engine.endVirtualT(), auto-pause.
 *  - `pause()`: cancels pending rAF, sets engine to paused.
 *  - On unmount: rAF is cancelled via useEffect cleanup.
 *  - On (index, sessionId) change: engine is recreated; any running rAF
 *    is cancelled first.
 *  - Speed change while playing: restarts the rAF loop with the new multiplier
 *    (play() is called again, which cancels the old rAF before starting a new one).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createEngine } from './engine-core.js';
import type { EngineHandle, ReplayState } from './engine-core.js';
import type { FileReplayState } from '../../index/reconstruct-file-provenance.js';
import type { EventIndex } from '../../index/event-index.js';

// Re-export for convenience.
export type { ReplayState } from './engine-core.js';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseReplayEngineResult = {
  state: ReplayState;
  fileStates: Map<string, FileReplayState>;
  files: string[];
  play(speed?: number): void;
  pause(): void;
  step(n?: number): void;
  seek(globalIdx: number): void;
};

/**
 * @param index     The EventIndex for the whole bundle. May be null (guard: returns no-op).
 * @param sessionId Which session to replay.
 */
export function useReplayEngine(
  index: EventIndex | null,
  sessionId: string,
): UseReplayEngineResult {
  // Engine handle lives in a ref so we don't re-create it on every render.
  const engineRef = useRef<EngineHandle | null>(null);
  // rAF id lives in a ref so the cancel callback always sees the latest id.
  const rafRef = useRef<number | null>(null);
  // Last wall-clock timestamp for rAF loop delta computation.
  const lastFrameWallMsRef = useRef<number>(0);
  // Speed ref: always reflects the latest speed, read inside the rAF closure
  // so there is no stale-closure footgun when speed changes during playback.
  const speedRef = useRef<number>(1);

  // React state: the only things that trigger re-renders.
  const [replayState, setReplayState] = useState<ReplayState>(() => ({
    status: 'paused',
    currentGlobalIdx: -1,
    speed: 1,
    sessionId,
    virtualT: 0,
  }));
  const [fileStates, setFileStates] = useState<Map<string, FileReplayState>>(new Map());
  const [files, setFiles] = useState<string[]>([]);

  // ---------------------------------------------------------------------------
  // (Re-)create engine when index or sessionId changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Cancel any running rAF before recreating the engine.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (index === null) {
      engineRef.current = null;
      setReplayState({ status: 'paused', currentGlobalIdx: -1, speed: 1, sessionId, virtualT: 0 });
      setFileStates(new Map());
      setFiles([]);
      return;
    }

    const engine = createEngine(index, sessionId);
    engineRef.current = engine;
    speedRef.current = engine.getState().speed;

    setReplayState(engine.getState());
    setFileStates(engine.getFileStates());
    setFiles(engine.getFiles());

    return () => {
      // Cleanup: cancel rAF when engine is replaced or component unmounts.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [index, sessionId]);

  // ---------------------------------------------------------------------------
  // Helper: sync React state from the engine after a mutation.
  // ---------------------------------------------------------------------------
  const syncFromEngine = useCallback((engine: EngineHandle) => {
    setReplayState(engine.getState());
    setFileStates(engine.getFileStates());
  }, []);

  // ---------------------------------------------------------------------------
  // cancelRaf helper (idempotent)
  // ---------------------------------------------------------------------------
  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // play(speed?)
  //
  // Uses a requestAnimationFrame loop so events replay at the actual rate they
  // were recorded. virtualDelta = wallDelta * speed, passed to engine.tick().
  // ---------------------------------------------------------------------------
  const play = useCallback(
    (speed?: number) => {
      const engine = engineRef.current;
      if (engine === null) return;

      cancelRaf();

      const effectiveSpeed = speed ?? engine.getState().speed;
      engine.setSpeed(effectiveSpeed);
      speedRef.current = effectiveSpeed;
      engine.setPlaying();
      syncFromEngine(engine);

      // Capture starting wall time.
      lastFrameWallMsRef.current = performance.now();

      function rafCallback(nowWall: number) {
        const eng = engineRef.current;
        if (eng === null) {
          rafRef.current = null;
          return;
        }

        const wallDelta = nowWall - lastFrameWallMsRef.current;
        lastFrameWallMsRef.current = nowWall;

        const virtualDelta = wallDelta * speedRef.current;
        eng.tick(virtualDelta);
        syncFromEngine(eng);

        // Check for end-of-stream: virtualT reached or passed endVirtualT.
        if (eng.getState().virtualT >= eng.endVirtualT() && eng.eventCount() > 0) {
          // Auto-pause at end of stream.
          rafRef.current = null;
          eng.setPaused();
          syncFromEngine(eng);
          return;
        }

        rafRef.current = requestAnimationFrame(rafCallback);
      }

      rafRef.current = requestAnimationFrame(rafCallback);
    },
    [cancelRaf, syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // pause()
  // ---------------------------------------------------------------------------
  const pause = useCallback(() => {
    cancelRaf();
    const engine = engineRef.current;
    if (engine === null) return;
    engine.setPaused();
    syncFromEngine(engine);
  }, [cancelRaf, syncFromEngine]);

  // ---------------------------------------------------------------------------
  // step(n)
  // ---------------------------------------------------------------------------
  const step = useCallback(
    (n = 1) => {
      const engine = engineRef.current;
      if (engine === null) return;
      // Always pause before stepping: standard media-player UX.
      // (Matches behavior of conventional playback controls: step is a scrub operation.)
      cancelRaf();
      engine.setPaused();
      engine.step(n);
      syncFromEngine(engine);
    },
    [cancelRaf, syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // seek(globalIdx)
  // ---------------------------------------------------------------------------
  const seek = useCallback(
    (globalIdx: number) => {
      const engine = engineRef.current;
      if (engine === null) return;
      engine.seek(globalIdx);
      syncFromEngine(engine);
    },
    [syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // Stable result object (avoids unnecessary re-renders in consumers).
  // ---------------------------------------------------------------------------
  return useMemo(
    () => ({ state: replayState, fileStates, files, play, pause, step, seek }),
    [replayState, fileStates, files, play, pause, step, seek],
  );
}
