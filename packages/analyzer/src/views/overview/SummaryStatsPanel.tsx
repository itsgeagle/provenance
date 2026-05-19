/**
 * SummaryStatsPanel — bundle-level summary numbers.
 *
 * PRD §7.2.
 *
 * Displays session count, assignment id, active/idle time, file list with
 * per-file metrics, and a best-effort LOC proxy derived from char stats.
 */

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { computeStats } from '../../index/stats.js';
import { formatDuration } from '../../lib/format.js';
import type { EventIndex } from '../../index/event-index.js';
import type { Bundle } from '../../loader/types.js';

interface SummaryStatsPanelProps {
  index: EventIndex;
  bundle: Bundle;
}

export function SummaryStatsPanel({ index, bundle }: SummaryStatsPanelProps) {
  const stats = useMemo(() => computeStats(index), [index]);

  const files = Array.from(stats.perFile.values());

  // LOC approximation:
  //   "added" ≈ chars_typed + chars_pasted (characters that entered the file).
  //   "external delta" is shown separately since we can't direction-distinguish add vs remove.
  //   A tooltip notes this is a best-effort approximation.
  const totalCharsAdded = files.reduce((acc, f) => acc + f.charsTyped + f.charsPasted, 0);
  const totalExternalDelta = files.reduce((acc, f) => acc + f.charsExternalChangeDelta, 0);

  return (
    <Card data-testid="summary-stats-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Top-level stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatBox label="Sessions" value={String(bundle.sessions.length)} testId="stat-sessions" />
          <StatBox
            label="Assignment"
            value={bundle.manifest.assignment_id}
            testId="stat-assignment"
          />
          <StatBox
            label="Active time"
            value={formatDuration(stats.totalActiveMs)}
            testId="stat-active-time"
          />
          <StatBox
            label="Idle time"
            value={formatDuration(stats.totalIdleMs)}
            testId="stat-idle-time"
          />
        </div>

        {/* LOC approximation */}
        <div className="rounded-md border px-4 py-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Character activity (best-effort)
          </p>
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-lg font-bold tabular-nums" data-testid="stat-chars-added">
                {totalCharsAdded.toLocaleString()}
              </p>
              <p
                className="text-xs text-muted-foreground"
                title="Sum of typed + pasted characters across all files. Does not account for deletions."
              >
                chars typed + pasted ⓘ
              </p>
            </div>
            {totalExternalDelta > 0 && (
              <div>
                <p className="text-lg font-bold tabular-nums" data-testid="stat-external-delta">
                  {totalExternalDelta.toLocaleString()}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  title="Absolute sum of size changes from external file modifications detected during the session."
                >
                  external change delta ⓘ
                </p>
              </div>
            )}
          </div>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Files ({files.length})
            </p>
            <div className="space-y-1" data-testid="file-list">
              {files.map((f) => (
                <div
                  key={f.filePath}
                  className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm"
                  data-testid={`file-row-${f.filePath}`}
                >
                  <span className="min-w-0 truncate font-mono text-xs" title={f.filePath}>
                    {f.filePath}
                  </span>
                  <div className="ml-4 flex shrink-0 gap-3 text-xs text-muted-foreground">
                    <span title="Characters typed">{f.charsTyped.toLocaleString()} typed</span>
                    <span title="Characters pasted">{f.charsPasted.toLocaleString()} pasted</span>
                    <span title="Save events">
                      {f.saves} save{f.saves !== 1 ? 's' : ''}
                    </span>
                    {f.reconstructionTainted && (
                      <span className="text-amber-600 font-semibold">tainted</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {files.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="no-files-message">
            No file activity recorded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-md border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}
