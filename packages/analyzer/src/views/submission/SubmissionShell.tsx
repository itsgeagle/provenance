/**
 * SubmissionShell — tab shell for the per-submission drill-in view.
 *
 * Phase 23. Route: /s/:semesterSlug/sub/:submissionId
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

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type SubmissionTab = 'overview' | 'timeline' | 'replay' | 'validation' | 'export';

const ALL_TABS: { id: SubmissionTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'replay', label: 'Replay' },
  { id: 'validation', label: 'Validation' },
  { id: 'export', label: 'Export' },
];

// ---------------------------------------------------------------------------
// SubmissionShell
// ---------------------------------------------------------------------------

export function SubmissionShell() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as SubmissionTab | null;
  const activeTab: SubmissionTab =
    tabParam && ['overview', 'timeline', 'replay', 'validation', 'export'].includes(tabParam)
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
      <div className="flex flex-col min-h-0" data-testid="submission-shell">
        {/* Tab nav */}
        <nav className="border-b border-gray-200 bg-white px-4 sm:px-6">
          <div className="flex gap-0 -mb-px">
            {ALL_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors focus:outline-none ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
                data-testid={`tab-${tab.id}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Tab content */}
        <div className="flex-1 overflow-auto bg-gray-50" data-testid="tab-content">
          {activeTab === 'overview' && <Overview />}
          {activeTab === 'timeline' && <Timeline />}
          {activeTab === 'replay' && <Replay />}
          {activeTab === 'validation' && <Validation />}
          {activeTab === 'export' && <ExportPanel />}
        </div>
      </div>
    </ApiSubmissionDataProviderContext>
  );
}
