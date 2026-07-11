/**
 * SubmissionShell — tab shell for the per-submission drill-in view.
 *
 * Phase 23. Route: /s/:courseSlug/:semesterSlug/sub/:submissionId
 *
 * Tabs:
 * - Overview  (shipped Phase 23) — summary card + validation + flags + files
 * - Timeline  (shipped Phase 23) — event list with kind/file filters
 * - Replay    (stub Phase 23, full Phase 25) — Monaco replay + scrubbing
 * - Validation (stub Phase 23, full Phase 24) — full validation panel
 * - Export    (stub Phase 23, full Phase 24) — export panel
 *
 * The shell mounts ApiSubmissionDataProviderContext so all tab children can
 * call useSubmissionData() without knowing they're in the API-backed path.
 *
 * URL state: ?tab=overview|timeline|replay|validation|export
 * Defaults to 'overview'.
 */

import { useParams, useSearchParams } from 'react-router-dom';
import { ApiSubmissionDataProviderContext } from '../../data/ApiSubmissionDataProvider.js';
import { Overview } from './Overview.js';
import { Timeline } from './Timeline.js';
import { Replay } from './Replay.js';
import { Validation } from './Validation.js';
import { ExportPanel } from './ExportPanel.js';
import { Source } from './Source.js';

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type SubmissionTab = 'overview' | 'timeline' | 'replay' | 'validation' | 'export' | 'source';

const ALL_TABS: { id: SubmissionTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'replay', label: 'Replay' },
  { id: 'validation', label: 'Validation' },
  { id: 'export', label: 'Export' },
  { id: 'source', label: 'Source' },
];

// ---------------------------------------------------------------------------
// SubmissionShell
// ---------------------------------------------------------------------------

export function SubmissionShell() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as SubmissionTab | null;
  const activeTab: SubmissionTab =
    tabParam &&
    ['overview', 'timeline', 'replay', 'validation', 'export', 'source'].includes(tabParam)
      ? tabParam
      : 'overview';

  function setTab(tab: SubmissionTab) {
    const next = new URLSearchParams(searchParams);
    if (tab === 'overview') {
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    setSearchParams(next, { replace: true });
  }

  return (
    <ApiSubmissionDataProviderContext submissionId={submissionId}>
      <div className="flex flex-1 flex-col min-h-0" data-testid="submission-shell">
        {/* Tab nav — WAI-ARIA tabs pattern applied to route-driven buttons
            (not the stateful Radix Tabs primitive, which owns its own panel
            state and doesn't fit URL-driven routing). */}
        <nav className="border-b border-gray-200 bg-white px-4 sm:px-6">
          <div className="flex gap-0 -mb-px" role="tablist" aria-label="Submission views">
            {ALL_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="submission-tabpanel"
                onClick={() => setTab(tab.id)}
                className={`px-4 py-3 text-sm border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                  activeTab === tab.id
                    ? 'border-blue-600 font-semibold text-blue-700'
                    : 'border-transparent font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
                data-testid={`tab-${tab.id}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Tab content
            - Replay locks itself to the viewport so the transport + jump bars
              stay on screen even when the event sidebar has thousands of rows;
              children manage internal scroll. Use overflow-hidden + min-h-0.
            - Other tabs grow with content, so use overflow-auto to scroll. */}
        <div
          id="submission-tabpanel"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          tabIndex={0}
          className={`flex-1 min-h-0 bg-gray-50 ${
            activeTab === 'replay' ? 'overflow-hidden' : 'overflow-auto'
          }`}
          data-testid="tab-content"
        >
          {activeTab === 'overview' && <Overview />}
          {activeTab === 'timeline' && <Timeline />}
          {activeTab === 'replay' && <Replay />}
          {activeTab === 'validation' && <Validation />}
          {activeTab === 'export' && <ExportPanel />}
          {activeTab === 'source' && <Source />}
        </div>
      </div>
    </ApiSubmissionDataProviderContext>
  );
}
