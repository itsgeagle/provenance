/**
 * FileTabs — one tab per file under review in the replay view.
 *
 * Clicking a tab calls onFileChange(filePath), which switches the Monaco model
 * in the parent ReplayView.
 *
 * Because replay spans the whole bundle, this lists EVERY file in the
 * submission, not just the ones touched in the session the playhead is in — a
 * file edited in session 1 and left alone in session 2 is still part of the
 * work and its content is still reconstructable. To keep that from being
 * misleading, each tab carries a last-edited badge, and files with no activity
 * in the current session render dimmed.
 *
 * Displays only the filename (basename) to keep tabs short; full path is shown
 * in the aria-label for accessibility.
 */

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.js';
import { cn } from '@/lib/utils';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { computeFileRecency, formatRecency } from './file-recency.js';

type FileTabsProps = {
  /** Ordered list of files under review (from engine.getFiles() — whole bundle). */
  files: string[];
  /** Currently selected file path. */
  activeFile: string | null;
  /** Called when the user clicks a tab. */
  onFileChange(filePath: string): void;
  /** Whole-bundle index, for resolving each file's last edit. */
  index?: EventIndex | undefined;
  /** Playhead position, as a globalIdx. */
  currentGlobalIdx?: number | undefined;
  /** The session the playhead is currently inside. */
  currentSessionId?: string | undefined;
};

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function FileTabs({
  files,
  activeFile,
  onFileChange,
  index,
  currentGlobalIdx,
  currentSessionId,
}: FileTabsProps) {
  if (files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-2 py-1" data-testid="file-tabs-empty">
        No files
      </div>
    );
  }

  return (
    <Tabs value={activeFile ?? files[0] ?? ''} onValueChange={onFileChange} data-testid="file-tabs">
      <TabsList className="h-auto flex-wrap gap-1 bg-transparent p-0">
        {files.map((filePath) => {
          const recency =
            index !== undefined && currentGlobalIdx !== undefined && currentSessionId !== undefined
              ? computeFileRecency(index, filePath, currentGlobalIdx, currentSessionId)
              : null;
          const badge = recency !== null ? formatRecency(recency) : null;
          // Dim anything with no activity in the session the playhead is in, so
          // stale tabs don't read as active work.
          const isStale = recency !== null && recency.state !== 'current-session';

          return (
            <TabsTrigger
              key={filePath}
              value={filePath}
              aria-label={filePath}
              className={cn('text-xs px-2 py-1 h-7', isStale && 'opacity-50')}
              title={
                isStale && badge !== null
                  ? `${filePath} — not edited in this session (last edited ${badge})`
                  : filePath
              }
              data-testid={`file-tab-${filePath}`}
              data-stale={isStale ? 'true' : undefined}
            >
              {basename(filePath)}
              {badge !== null && (
                <span
                  className="ml-1.5 text-[10px] font-normal text-muted-foreground"
                  data-testid={`file-tab-recency-${filePath}`}
                >
                  {badge}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
