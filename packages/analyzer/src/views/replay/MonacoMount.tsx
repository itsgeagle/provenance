/**
 * MonacoMount — lazy-loaded Monaco editor, read-only.
 *
 * Loaded via React.lazy() so the Monaco bundle (~4 MB) is only fetched when
 * the /replay route is actually visited (per implementation plan §0 decision 9).
 *
 * Language detection from file extension:
 *   .py → python
 *   .js → javascript
 *   .ts → typescript
 *   .tsx → typescript
 *   .jsx → javascript
 *   .json → json
 *   .md → markdown
 *   default → plaintext
 *
 * Value prop updates are handled by @monaco-editor/react's `value` prop,
 * which calls editor.setValue() internally. This is simpler than managing
 * model URIs manually and sufficient for Phase 13's step-by-step replay.
 * For extremely rapid step() calls (slider scrub) a requestAnimationFrame
 * throttle is applied at the TransportBar level, not here.
 */

import React, { Suspense } from 'react';

// Lazy-loaded Monaco editor. Vite will split this into a separate chunk.
const MonacoEditor = React.lazy(() => import('@monaco-editor/react'));

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

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
// Props
// ---------------------------------------------------------------------------

type MonacoMountProps = {
  /** Current file content to display. */
  content: string;
  /** File path used for language detection. */
  filePath: string;
  /** Additional className for the outer wrapper. */
  className?: string;
};

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function MonacoSkeleton({ extraClass }: { extraClass: string }) {
  return (
    <div
      className={`flex items-center justify-center bg-muted/30 rounded-md ${extraClass}`}
      data-testid="monaco-skeleton"
      role="status"
      aria-label="Loading editor..."
    >
      <span className="text-sm text-muted-foreground animate-pulse">Loading editor…</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MonacoMount
// ---------------------------------------------------------------------------

/**
 * Renders a read-only Monaco editor showing `content` with syntax highlighting
 * for `filePath`'s language. Wrapped in <Suspense> so it renders a skeleton
 * while the Monaco chunk loads.
 */
export function MonacoMount({ content, filePath, className }: MonacoMountProps) {
  const language = languageFromPath(filePath);

  return (
    <Suspense fallback={<MonacoSkeleton extraClass={className ?? ''} />}>
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
        {...(className !== undefined ? { className } : {})}
        data-testid="monaco-editor"
      />
    </Suspense>
  );
}
