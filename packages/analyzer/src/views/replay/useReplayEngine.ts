/**
 * useReplayEngine — React adapter over the pure engine-core.
 *
 * Responsibilities:
 *  - Instantiates/re-instantiates the engine when (index, sessionId) changes.
 *  - Manages the playback interval (timer). CLAUDE.md rule: every interval
 *    has an explicit cleanup path.
 *  - Exposes `play`, `pause`, `step`, `seek` to React components.
 *  - Exposes reactive `state`, `fileStates`, `files` (via useState).
 *
 * Design choice: the engine handle is stored in a ref (not state) to avoid
 * re-creating it on every render. Only the *output* (ReplayState + fileStates)
 * is stored in state so React re-renders on meaningful changes.
 *
 * Timer contract:
 *  - `play(speed?)`: starts an interval that calls engine.step(1) every
 *    (1000 / speed) ms. If the engine reaches the last event, the interval is
 *    cleared and status is set to 'paused'.
 *  - `pause()`: clears the interval, sets status to 'paused'.
 *  - On unmount: interval is cleared via useEffect cleanup.
 *  - On (index, sessionId) change: engine is recreated; any running interval
 *    is cleared first.
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
  // Interval id lives in a ref so callbacks always see the latest value.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // React state: the only things that trigger re-renders.
  const [replayState, setReplayState] = useState<ReplayState>(() => ({
    status: 'paused',
    currentGlobalIdx: -1,
    speed: 1,
    sessionId,
  }));
  const [fileStates, setFileStates] = useState<Map<string, FileReplayState>>(new Map());
  const [files, setFiles] = useState<string[]>([]);

  // ---------------------------------------------------------------------------
  // (Re-)create engine when index or sessionId changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Clear any running interval before recreating the engine.
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (index === null) {
      engineRef.current = null;
      setReplayState({ status: 'paused', currentGlobalIdx: -1, speed: 1, sessionId });
      setFileStates(new Map());
      setFiles([]);
      return;
    }

    const engine = createEngine(index, sessionId);
    engineRef.current = engine;

    setReplayState(engine.getState());
    setFileStates(engine.getFileStates());
    setFiles(engine.getFiles());

    return () => {
      // Cleanup: clear any interval when engine is replaced or component unmounts.
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
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
  // clearInterval helper (idempotent)
  // ---------------------------------------------------------------------------
  const clearPlayInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // play(speed?)
  // ---------------------------------------------------------------------------
  const play = useCallback(
    (speed?: number) => {
      const engine = engineRef.current;
      if (engine === null) return;

      clearPlayInterval();

      const effectiveSpeed = speed ?? engine.getState().speed;
      engine.setSpeed(effectiveSpeed);
      engine.setPlaying();
      syncFromEngine(engine);

      const intervalMs = Math.max(1, Math.round(1000 / effectiveSpeed));
      intervalRef.current = setInterval(() => {
        const eng = engineRef.current;
        if (eng === null) {
          clearPlayInterval();
          return;
        }
        const maxIdx = eng.eventCount() - 1;
        if (eng.getState().currentGlobalIdx >= maxIdx) {
          // Reached end of stream: auto-pause.
          clearPlayInterval();
          eng.setPaused();
          syncFromEngine(eng);
          return;
        }
        eng.step(1);
        syncFromEngine(eng);
      }, intervalMs);
    },
    [clearPlayInterval, syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // pause()
  // ---------------------------------------------------------------------------
  const pause = useCallback(() => {
    clearPlayInterval();
    const engine = engineRef.current;
    if (engine === null) return;
    engine.setPaused();
    syncFromEngine(engine);
  }, [clearPlayInterval, syncFromEngine]);

  // ---------------------------------------------------------------------------
  // step(n)
  // ---------------------------------------------------------------------------
  const step = useCallback(
    (n = 1) => {
      const engine = engineRef.current;
      if (engine === null) return;
      // Always pause before stepping: standard media-player UX.
      // (Matches behavior of conventional playback controls: step is a scrub operation.)
      clearPlayInterval();
      engine.setPaused();
      engine.step(n);
      syncFromEngine(engine);
    },
    [clearPlayInterval, syncFromEngine],
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
