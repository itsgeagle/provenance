/**
 * ReplayView — top-level layout for the /replay/:sessionId route.
 *
 * Layout (Phase 14):
 *   ┌─────────────────────────────────────┬──────────────┐
 *   │ FileTabs (full width)               │              │
 *   ├─────────────────────────────────────┤ EventSidebar │
 *   │ MonacoMount (70% width)             │ (30% width)  │
 *   │ + GutterDecorations (headless)      │              │
 *   │ + LineHoverProvider (headless)      │              │
 *   │ + ColorLegend (overlay)             │              │
 *   ├─────────────────────────────────────┴──────────────┤
 *   │ TransportBar (full width)                          │
 *   └────────────────────────────────────────────────────┘
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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Navigate, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import type * as MonacoType from 'monaco-editor';
import { useBundle } from '../../context/BundleContext.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import { useReplayEngine } from './useReplayEngine.js';
import { FileTabs } from './FileTabs.js';
import { MonacoMount, languageFromPath } from './MonacoMount.js';
import { TransportBar } from './TransportBar.js';
import { SpeedControl } from './SpeedControl.js';
import { JumpControls } from './JumpControls.js';
import { GutterDecorations } from './GutterDecorations.js';
import { LineHoverProvider } from './LineHoverProvider.js';
import { EventSidebar } from './EventSidebar.js';
import { ColorLegend } from './ColorLegend.js';
import { FocusAwayOverlay } from './FocusAwayOverlay.js';
import { currentFocusAwaySpan, currentEditedFile } from './focus-and-follow.js';
import { CursorMarker } from './CursorMarker.js';
import { FollowCursor } from './FollowCursor.js';
import { currentSelection } from './cursor-position.js';
import {
  findNextPaste,
  findNextExternalChange,
  findNextFlag,
  findNextFileSwitch,
  buildFlaggedGlobalIdxSet,
  countRemainingPastes,
  countRemainingExternalChanges,
  countRemainingFlags,
  countRemainingFileSwitches,
  findNextSeam,
  countRemainingSeams,
} from './jump-predicates.js';
import { buildFlaggedSeamIdxs } from './seam-flags.js';

// ---------------------------------------------------------------------------
// ReplayHeader — back button + session context info.
// Sits above the FileTabs row; shrink-0 so it doesn't compete with the editor.
// ---------------------------------------------------------------------------

interface ReplayHeaderProps {
  sessionId: string;
  sourceFilename: string;
  index: EventIndex;
}

function ReplayHeader({ sessionId, sourceFilename, index }: ReplayHeaderProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    // go back in history if there's a previous entry, else fall back to /local/overview.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      void navigate('/local/overview');
    }
  };

  // Session ids in the bundle's chronological order (bySessionId is built from
  // wall-sorted events, so its key order is oldest → newest).
  const sessionIds = useMemo(() => [...index.bySessionId.keys()], [index]);
  const total = sessionIds.length;
  const ordinal = sessionIds.indexOf(sessionId) + 1;

  // Switch sessions by navigating to the sibling replay route. A fresh path
  // (no ?event) starts the new session at its beginning.
  function handleSessionChange(e: React.ChangeEvent<HTMLSelectElement>) {
    void navigate(`/local/replay/${e.target.value}`);
  }

  const label = `${sourceFilename} · ${sessionId.slice(0, 8)}…`;

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b bg-background px-4"
      style={{ height: '44px' }}
      data-testid="replay-header"
    >
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="replay-back-btn"
        aria-label="Back"
      >
        <ChevronLeft className="h-4 w-4" />
        Back
      </button>
      <span className="mx-2 h-4 border-l" aria-hidden="true" />
      {total > 1 ? (
        <div className="flex min-w-0 items-center gap-2" data-testid="replay-session-switcher">
          <select
            aria-label="Session"
            value={sessionId}
            onChange={handleSessionChange}
            className="rounded-md border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="replay-session-select"
          >
            {sessionIds.map((id, i) => {
              const startWall = index.bySessionId.get(id)?.[0]?.wall ?? null;
              const when = startWall !== null ? ` · ${new Date(startWall).toLocaleString()}` : '';
              return (
                <option key={id} value={id}>
                  {`Session ${i + 1} of ${total}${when}`}
                </option>
              );
            })}
          </select>
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={`Session: ${sessionId} · Bundle: ${sourceFilename}`}
          >
            {sourceFilename}
          </span>
        </div>
      ) : (
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={`Session: ${sessionId} · Bundle: ${sourceFilename}`}
        >
          {label}
        </span>
      )}
      {ordinal > 0 && total > 1 && (
        <span className="ml-auto shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
          {ordinal} / {total}
        </span>
      )}
    </div>
  );
}

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
 *   3. If session not found → <Navigate to="/local/overview" />.
 *   4. Otherwise renders <ReplayViewInner>.
 *
 * ReplayViewInner:
 *   - Only called when session is confirmed present.
 *   - Contains all engine + URL-state logic.
 */
export function ReplayView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { index, flags, bundles, selectedBundleId } = useBundle();

  const sessionExists = useMemo(() => {
    if (index === null || !sessionId) return false;
    return index.bySessionId.has(sessionId);
  }, [index, sessionId]);

  const sourceFilename = useMemo(() => {
    const selected = bundles.find((b) => b.id === selectedBundleId) ?? bundles[0];
    return selected?.sourceFilename ?? '';
  }, [bundles, selectedBundleId]);

  if (!sessionId || index === null || !sessionExists) {
    if (sessionId && index !== null && !sessionExists) {
      console.warn(
        `[ReplayView] session "${sessionId}" not found in index; redirecting to /local/overview`,
      );
    }
    return <Navigate to="/local/overview" replace />;
  }

  return (
    <ReplayInner
      sessionId={sessionId}
      index={index}
      flags={flags}
      sourceFilename={sourceFilename}
      showHeader={true}
    />
  );
}

// ---------------------------------------------------------------------------
// ReplayInner — engine + UI, no BundleContext dependency
// ---------------------------------------------------------------------------

export type ReplayInnerProps = {
  sessionId: string;
  index: EventIndex;
  flags: Flag[];
  /** Shown in ReplayHeader's context label. Pass empty string to skip. */
  sourceFilename: string;
  /** Render the back-button header above FileTabs. Default true (used by /local). */
  showHeader?: boolean;
};

export function ReplayInner({
  sessionId,
  index,
  flags,
  sourceFilename,
  showHeader = true,
}: ReplayInnerProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const engine = useReplayEngine(index);
  const { state, fileStates, files, seams, play, pause, step, seek } = engine;

  // Active file tab — null means "use first file".
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // Resolved file: either the selected tab or the first available file.
  const resolvedFile = activeFile ?? files[0] ?? null;

  // Content for Monaco.
  const content = resolvedFile !== null ? (fileStates.get(resolvedFile)?.content ?? '') : '';

  // FileReplayState for the active file (used by GutterDecorations + LineHoverProvider).
  const activeFileState = resolvedFile !== null ? (fileStates.get(resolvedFile) ?? null) : null;

  // Total event count for the bundle (passed to TransportBar).
  const eventCount = index?.ordered.length ?? 0;

  // The whole bundle's events, across every session. Replay is not scoped to a
  // session: the sidebar, jump targets, focus-away spans, and edited-file
  // tracking all span the full submission.
  const bundleEvents = useMemo(() => index?.ordered ?? [], [index]);

  // ---------------------------------------------------------------------------
  // Focus-away overlay + auto-follow the edited file.
  // ---------------------------------------------------------------------------

  // Whether the student is focused away from the window at the current playhead.
  const focusAway = useMemo(
    () => currentFocusAwaySpan(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );

  // The file being edited at the current playhead.
  const editedFile = useMemo(
    () => currentEditedFile(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );

  // Auto-follow: switch the active file ONLY when the edited file transitions to a
  // new path. This follows the action during playback without overriding a manual
  // tab selection while paused (the playhead — and thus editedFile — isn't moving).
  const prevEditedFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (editedFile !== null && editedFile !== prevEditedFileRef.current) {
      prevEditedFileRef.current = editedFile;
      setActiveFile(editedFile);
    }
  }, [editedFile]);

  // The student's cursor/selection in the shown file at the current playhead.
  const cursorSelection = useMemo(
    () => currentSelection(bundleEvents, state.currentGlobalIdx, resolvedFile),
    [bundleEvents, state.currentGlobalIdx, resolvedFile],
  );

  // ---------------------------------------------------------------------------
  // Jump controls: pre-compute next targets + remaining counts.
  // (A44): flaggedSet is memoized so buildFlaggedGlobalIdxSet doesn't rebuild
  // on every render. It only changes when flags or the index's bySeq changes.
  // ---------------------------------------------------------------------------
  const flaggedSet = useMemo(
    () => buildFlaggedGlobalIdxSet(flags, index?.bySeq ?? new Map()),
    [flags, index],
  );

  const nextPaste = useMemo(
    () => findNextPaste(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextExternalChange = useMemo(
    () => findNextExternalChange(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextFlag = useMemo(
    () => findNextFlag(bundleEvents, state.currentGlobalIdx, flaggedSet),
    [bundleEvents, state.currentGlobalIdx, flaggedSet],
  );
  const nextFileSwitch = useMemo(
    () => findNextFileSwitch(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingPastes = useMemo(
    () => countRemainingPastes(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingExternalChanges = useMemo(
    () => countRemainingExternalChanges(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingFlags = useMemo(
    () => countRemainingFlags(bundleEvents, state.currentGlobalIdx, flaggedSet),
    [bundleEvents, state.currentGlobalIdx, flaggedSet],
  );
  const remainingFileSwitches = useMemo(
    () => countRemainingFileSwitches(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextSeam = useMemo(
    () => findNextSeam(seams, state.currentGlobalIdx),
    [seams, state.currentGlobalIdx],
  );
  const remainingSeams = useMemo(
    () => countRemainingSeams(seams, state.currentGlobalIdx),
    [seams, state.currentGlobalIdx],
  );

  // Seams where the inter_session_external_change heuristic fired — file content
  // demonstrably changed while the recorder was off.
  const flaggedSeamIdxs = useMemo(
    () => buildFlaggedSeamIdxs(seams, flags, index?.bySeq ?? new Map()),
    [seams, flags, index],
  );

  // Monaco editor + monaco instances (set via onMount callback).
  const [monacoEditor, setMonacoEditor] = useState<MonacoEditorNS.IStandaloneCodeEditor | null>(
    null,
  );
  const [monacoInstance, setMonacoInstance] = useState<typeof MonacoType | null>(null);

  const handleEditorMount = useCallback(
    (ed: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof MonacoType) => {
      setMonacoEditor(ed);
      setMonacoInstance(monaco);
    },
    [],
  );

  // Language for the hover provider (derived from the active file path).
  const language = useMemo(() => {
    return resolvedFile !== null ? languageFromPath(resolvedFile) : 'plaintext';
  }, [resolvedFile]);

  // ---------------------------------------------------------------------------
  // Mount: parse URL params → seek to initial event.
  // Only fires once (empty dep array, same rationale as A16).
  // ---------------------------------------------------------------------------
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    // ?event= is the position of record and wins when present.
    const eventParam = searchParams.get('event');
    if (eventParam !== null) {
      const idx = parseInt(eventParam, 10);
      if (!isNaN(idx)) {
        seek(idx);
        return;
      }
    }

    // Otherwise the session id in the route/query is an ENTRY ANCHOR, not a
    // scope: open the whole-bundle engine at that session's first event.
    const anchor = index?.bySessionId.get(sessionId)?.[0];
    if (anchor !== undefined) {
      seek(anchor.globalIdx);
    }
    // Mount-only: didInitRef guards re-fires; seek is stable via useCallback.
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
    // Use current engine speed. URL ?speed= is a delayed mirror (debounced 100ms),
    // not the source of truth. state.speed is updated synchronously by handleSpeedChange.
    // Reading the stale URL param here risks a race: if the user changes speed then
    // clicks Play within 100ms, the URL hasn't been written yet (A47).
    play(state.speed);
  }

  // SpeedControl: update the engine speed.
  // - If playing: restart with the new speed (recreates the interval).
  // - If paused: play(newSpeed) sets the engine's speed, then pause() immediately
  //   cancels the interval. The URL write-back effect picks up state.speed on the
  //   next render.
  const handleSpeedChange = useCallback(
    (newSpeed: number) => {
      if (state.status === 'playing') {
        // Restart the playback interval at the new rate.
        play(newSpeed);
      } else {
        // Update engine speed without actually playing: play sets speed,
        // pause cancels the interval. Net result: engine.speed === newSpeed,
        // status stays 'paused'.
        play(newSpeed);
        pause();
      }
    },
    [state.status, play, pause],
  );

  // JumpControls: seek to the target globalIdx. Seek does not change play
  // status (the engine stays playing/paused). We pause before seeking so
  // jumps always land in a paused/browseable state.
  const handleJumpSeek = useCallback(
    (globalIdx: number) => {
      pause();
      seek(globalIdx);
    },
    [pause, seek],
  );

  return (
    <div className="flex flex-col h-full" data-testid="replay-view">
      {/* Back button + session context + switcher — only shown in the /local route. */}
      {showHeader && (
        <ReplayHeader sessionId={sessionId} sourceFilename={sourceFilename} index={index} />
      )}

      {/* File tabs row */}
      <div className="px-4 pt-3 pb-1 border-b bg-background shrink-0">
        <FileTabs
          files={files}
          activeFile={resolvedFile}
          onFileChange={setActiveFile}
          index={index}
          currentGlobalIdx={state.currentGlobalIdx}
          currentSessionId={state.sessionId}
        />
      </div>

      {/* Main area: Monaco (70%) + EventSidebar (30%) */}
      <div className="flex flex-1 min-h-0">
        {/* Monaco editor — 70% width */}
        <div className="relative flex-1 min-w-0" style={{ flex: '0 0 70%' }}>
          {resolvedFile !== null ? (
            <>
              <MonacoMount
                content={content}
                filePath={resolvedFile}
                className="h-full w-full"
                onMount={handleEditorMount}
              />
              {/* Phase 14: headless side-effect drivers */}
              <GutterDecorations editor={monacoEditor} fileState={activeFileState} />
              {/* Student cursor / selection marker at the playhead. */}
              <CursorMarker editor={monacoEditor} selection={cursorSelection} />
              {/* Scroll the editor to keep that marker in view as replay plays. */}
              <FollowCursor editor={monacoEditor} selection={cursorSelection} content={content} />
              <LineHoverProvider
                editor={monacoEditor}
                monaco={monacoInstance}
                fileState={activeFileState}
                language={language}
                orderedEvents={bundleEvents}
              />
              {/* Color legend overlay */}
              <ColorLegend />
            </>
          ) : (
            <div
              className="flex items-center justify-center h-full text-sm text-muted-foreground"
              data-testid="no-file-placeholder"
            >
              No files under review in this session.
            </div>
          )}
          {/* Focus-away overlay — covers the code pane while the student is focused away. */}
          {focusAway !== null && <FocusAwayOverlay reason={focusAway.reason} />}
        </div>

        {/* Event sidebar — 30% width */}
        <div className="flex-1 min-w-0 min-h-0" style={{ flex: '0 0 30%' }}>
          <EventSidebar
            seams={seams}
            flaggedSeamIdxs={flaggedSeamIdxs}
            events={bundleEvents}
            currentGlobalIdx={state.currentGlobalIdx}
            onSeek={seek}
          />
        </div>
      </div>

      {/* Transport bar row: SpeedControl on right, TransportBar fills remaining space */}
      <div className="shrink-0">
        <div className="flex items-center border-t bg-background">
          <div className="flex-1">
            <TransportBar
              seams={seams}
              state={state}
              events={bundleEvents}
              onPlay={handlePlay}
              onPause={pause}
              onStep={step}
              onSeek={seek}
            />
          </div>
          {/* Speed control sits at the right edge of the transport row */}
          <div className="shrink-0 px-3 py-2 border-l" data-testid="speed-control-wrapper">
            <SpeedControl
              speed={state.speed}
              onSpeedChange={handleSpeedChange}
              disabled={eventCount === 0}
            />
          </div>
        </div>
      </div>

      {/* Jump controls strip */}
      <div className="shrink-0">
        <JumpControls
          nextPaste={nextPaste}
          nextExternalChange={nextExternalChange}
          nextFlag={nextFlag}
          nextFileSwitch={nextFileSwitch}
          remainingPastes={remainingPastes}
          remainingExternalChanges={remainingExternalChanges}
          remainingFlags={remainingFlags}
          remainingFileSwitches={remainingFileSwitches}
          nextSeam={nextSeam}
          remainingSeams={remainingSeams}
          hasSeams={seams.length > 0}
          onSeek={handleJumpSeek}
        />
      </div>
    </div>
  );
}
