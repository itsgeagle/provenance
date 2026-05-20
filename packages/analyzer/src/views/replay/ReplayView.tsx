/**
 * ReplayView — top-level layout for the /replay/:sessionId route.
 *
 * Layout:
 *   ┌─────────────────────────────────┐
 *   │ FileTabs                        │
 *   ├─────────────────────────────────┤
 *   │ MonacoMount          (flex-1)   │
 *   ├─────────────────────────────────┤
 *   │ TransportBar                    │
 *   └─────────────────────────────────┘
 *
 * Route guard:
 *   - Requires a loaded bundle (RequireBundle via App.tsx wrapping this route).
 *   - Requires that sessionId exists in the selected bundle's index.
 *     If not found: redirects to /overview with console.warn.
 *     Design choice (A34): /overview rather than /load because the user has a
 *     loaded bundle and /overview gives them a useful view with session info.
 *
 * URL state:
 *   ?event=:globalIdx  — current position (written back on change, debounced ~100ms).
 *   ?speed=:n          — playback speed (written back on state change).
 *
 *   On mount: parse params → seek(event).
 *   On state change: debounced write-back.
 *   Pattern mirrors TimelineView's A16 deep-link approach.
 *
 * Sidebar (Phase 14): reserved — not present in Phase 13.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Navigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import { useReplayEngine } from './useReplayEngine.js';
import { FileTabs } from './FileTabs.js';
import { MonacoMount } from './MonacoMount.js';
import { TransportBar } from './TransportBar.js';

// ---------------------------------------------------------------------------
// ReplayView — entry + session guard
// ---------------------------------------------------------------------------

/**
 * ReplayView is split into two components so that all hooks always execute
 * in the same order regardless of the guard result (React rules of hooks).
 *
 * ReplayView:
 *   1. Reads sessionId from URL params.
 *   2. Reads index from BundleContext.
 *   3. If session not found → <Navigate to="/overview" />.
 *   4. Otherwise renders <ReplayViewInner>.
 *
 * ReplayViewInner:
 *   - Only called when session is confirmed present.
 *   - Contains all engine + URL-state logic.
 */
export function ReplayView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { index } = useBundle();

  const sessionExists = useMemo(() => {
    if (index === null || !sessionId) return false;
    return index.bySessionId.has(sessionId);
  }, [index, sessionId]);

  if (!sessionId || index === null || !sessionExists) {
    if (sessionId && index !== null && !sessionExists) {
      console.warn(
        `[ReplayView] session "${sessionId}" not found in index; redirecting to /overview`,
      );
    }
    return <Navigate to="/overview" replace />;
  }

  return <ReplayViewInner sessionId={sessionId} />;
}

// ---------------------------------------------------------------------------
// ReplayViewInner
// ---------------------------------------------------------------------------

type ReplayViewInnerProps = { sessionId: string };

function ReplayViewInner({ sessionId }: ReplayViewInnerProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { index } = useBundle();

  const engine = useReplayEngine(index, sessionId);
  const { state, fileStates, files, play, pause, step, seek } = engine;

  // Active file tab — null means "use first file".
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // Resolved file: either the selected tab or the first available file.
  const resolvedFile = activeFile ?? files[0] ?? null;

  // Content for Monaco.
  const content = resolvedFile !== null ? (fileStates.get(resolvedFile)?.content ?? '') : '';

  // Total event count for the session (passed to TransportBar).
  const eventCount = index?.bySessionId.get(sessionId)?.length ?? 0;

  // ---------------------------------------------------------------------------
  // Mount: parse URL params → seek to initial event.
  // Only fires once (empty dep array, same rationale as A16).
  // ---------------------------------------------------------------------------
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    const eventParam = searchParams.get('event');
    if (eventParam !== null) {
      const idx = parseInt(eventParam, 10);
      if (!isNaN(idx)) {
        seek(idx);
      }
    }
    // Intentionally empty dep array: this effect handles initial URL→engine sync only
    // on mount. Re-firing on searchParams changes would re-seek on every URL write-back,
    // overriding navigation that happened during the session.
  }, []);

  // ---------------------------------------------------------------------------
  // URL write-back: debounced ~100ms on currentGlobalIdx or speed change.
  // Avoids infinite loop: setSearchParams with { replace: true } updates the
  // URL without pushing a history entry; the effect deps are engine state values,
  // not the searchParams object, so the URL change does not re-trigger this effect.
  // ---------------------------------------------------------------------------
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('event', String(state.currentGlobalIdx));
          next.set('speed', String(state.speed));
          return next;
        },
        { replace: true },
      );
    }, 100);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [state.currentGlobalIdx, state.speed, setSearchParams]);

  // ---------------------------------------------------------------------------
  // If files list changes (e.g. new session) and activeFile is no longer valid,
  // reset to default (first file).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (activeFile !== null && !files.includes(activeFile)) {
      setActiveFile(null);
    }
  }, [files, activeFile]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handlePlay() {
    // Read speed from URL param if present; otherwise use current engine speed.
    const speedParam = searchParams.get('speed');
    const parsedSpeed = speedParam !== null ? parseFloat(speedParam) : NaN;
    const speed = !isNaN(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : state.speed;
    play(speed);
  }

  return (
    <div className="flex flex-col h-full" data-testid="replay-view">
      {/* File tabs row */}
      <div className="px-4 pt-3 pb-1 border-b bg-background shrink-0">
        <FileTabs files={files} activeFile={resolvedFile} onFileChange={setActiveFile} />
      </div>

      {/* Monaco editor — fills remaining space */}
      <div className="flex-1 min-h-0">
        {resolvedFile !== null ? (
          <MonacoMount content={content} filePath={resolvedFile} className="h-full w-full" />
        ) : (
          <div
            className="flex items-center justify-center h-full text-sm text-muted-foreground"
            data-testid="no-file-placeholder"
          >
            No files under review in this session.
          </div>
        )}
      </div>

      {/* Transport bar */}
      <div className="shrink-0">
        <TransportBar
          state={state}
          eventCount={eventCount}
          onPlay={handlePlay}
          onPause={pause}
          onStep={step}
          onSeek={seek}
        />
      </div>

      {/* Phase 14: EventSidebar slot — not rendered in Phase 13. */}
    </div>
  );
}
