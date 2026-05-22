/**
 * Replay tab — provider-backed implementation (Phase 23).
 *
 * Features:
 * - File selector (dropdown) — uses provider.useFiles()
 * - Scrubber slider — range 0 to total_events - 1
 * - Monaco editor (read-only) — content via provider.useFileContent(path, atSeq)
 * - Debounced scrub (100ms) to avoid hammering the API
 *
 * Replaces ReplayStub. Does NOT import from v2's ReplayView — adapts the
 * provider pattern independently.
 *
 * Test note: Monaco is lazy-loaded via @monaco-editor/react. In test mode
 * (import.meta.env.MODE === 'test') a simple <textarea> is rendered instead,
 * so tests can assert content without jsdom Monaco complexity.
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';

// ---------------------------------------------------------------------------
// Lazy Monaco (only loaded when the tab is actually rendered in prod).
// ---------------------------------------------------------------------------

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'));

// ---------------------------------------------------------------------------
// MonacoOrTextarea — Monaco in prod, <textarea> in test
// ---------------------------------------------------------------------------

interface EditorProps {
  content: string;
  filePath: string;
}

function EditorArea({ content, filePath }: EditorProps) {
  // In test mode use a plain textarea to avoid jsdom/Monaco canvas issues.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vite injects import.meta.env at build time
  const mode = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.MODE : undefined) as
    | string
    | undefined;
  if (mode === 'test') {
    return (
      <textarea
        data-testid="replay-editor"
        value={content}
        readOnly
        className="w-full h-full font-mono text-sm resize-none border-0 outline-none bg-gray-900 text-gray-100 p-4"
      />
    );
  }

  const language = languageFromPath(filePath);

  return (
    <Suspense
      fallback={
        <div
          className="flex items-center justify-center h-full bg-gray-900 text-gray-400 text-sm"
          data-testid="monaco-skeleton"
        >
          Loading editor…
        </div>
      }
    >
      <MonacoEditor
        value={content}
        language={language}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: 'on',
          folding: false,
          wordWrap: 'off',
          renderLineHighlight: 'line',
        }}
        className="h-full w-full"
      />
    </Suspense>
  );
}

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':
      return 'python';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    default:
      return 'plaintext';
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export function Replay() {
  const provider = useSubmissionData();

  // --- Files ---
  const filesQuery = provider.useFiles();
  const files = filesQuery.data?.files ?? [];

  // --- Selected file ---
  const [selectedPath, setSelectedPath] = useState<string>('');

  // Auto-select first file once loaded
  useEffect(() => {
    if (selectedPath === '' && files.length > 0 && files[0] != null) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  // --- Summary for total event count ---
  const summaryQuery = provider.useSummary();
  const totalEvents = summaryQuery.data
    ? (() => {
        // Use per-file event count from stats if available
        return 100; // default; updated below via statsQuery
      })()
    : 0;

  const statsQuery = provider.useStats();
  // Total events from aggregate stats
  const totalEventCount = statsQuery.data?.aggregate.total_events ?? totalEvents;
  const maxSeq = totalEventCount > 0 ? totalEventCount - 1 : 0;

  // --- Scrubber state ---
  // atSeq: the committed value (sent to the API after debounce)
  // sliderValue: the live slider position (immediate)
  const [sliderValue, setSliderValue] = useState(0);
  const [atSeq, setAtSeq] = useState<number>(0);

  // Debounce ref for scrub
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSliderChange = useCallback((value: number) => {
    setSliderValue(value);
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setAtSeq(value);
    }, 100);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // --- File content ---
  const fileContentQuery = provider.useFileContent(selectedPath, atSeq);
  const content = fileContentQuery.data?.content ?? '';

  // --- File provenance (fetched alongside content but not yet visualised) ---
  provider.useFileProvenance(selectedPath, atSeq);

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (filesQuery.isLoading || statsQuery.isLoading) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-loading"
      >
        <p className="text-sm">Loading replay data…</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-no-files"
      >
        <p className="text-sm">No files available for this submission.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="replay-tab">
      {/* Top bar: file selector + seq info */}
      <div className="shrink-0 flex items-center gap-4 border-b border-gray-200 bg-white px-4 py-2">
        {/* File selector */}
        <label htmlFor="replay-file-select" className="text-sm font-medium text-gray-700 shrink-0">
          File
        </label>
        <select
          id="replay-file-select"
          value={selectedPath}
          onChange={(e) => {
            setSelectedPath(e.target.value);
            setSliderValue(0);
            setAtSeq(0);
          }}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid="replay-file-select"
        >
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
        </select>

        {/* Seq indicator */}
        <span className="ml-auto text-xs text-gray-500" data-testid="replay-seq-indicator">
          seq {atSeq} / {maxSeq}
        </span>
      </div>

      {/* Scrubber */}
      <div className="shrink-0 flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2">
        <span className="text-xs text-gray-500 shrink-0">0</span>
        <input
          type="range"
          min={0}
          max={maxSeq}
          value={sliderValue}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
          className="flex-1 accent-blue-600"
          data-testid="replay-scrubber"
          aria-label="Scrub replay position"
        />
        <span className="text-xs text-gray-500 shrink-0">{maxSeq}</span>
      </div>

      {/* Monaco editor area */}
      <div className="flex-1 min-h-0 relative">
        {fileContentQuery.isLoading && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-gray-900/60 z-10 text-white text-sm"
            data-testid="replay-content-loading"
          >
            Loading…
          </div>
        )}
        {fileContentQuery.data?.warning != null && (
          <div
            className="absolute top-2 right-2 z-10 rounded bg-amber-100 px-2 py-1 text-xs text-amber-700 border border-amber-200"
            data-testid="replay-taint-warning"
          >
            {fileContentQuery.data.warning}
          </div>
        )}
        <EditorArea content={content} filePath={selectedPath} />
      </div>
    </div>
  );
}
