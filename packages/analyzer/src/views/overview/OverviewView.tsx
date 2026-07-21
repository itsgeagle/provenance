/**
 * OverviewView — landing view after a bundle loads.
 *
 * PRD §7.2.
 *
 * Composes:
 *   - Actions (top action bar)
 *   - ValidationReportPanel (8 validation checks)
 *   - SummaryStatsPanel (session count, time, file list)
 *   - FlagDashboardPanel (heuristic flags with drawer)
 *
 * RequireBundle in App.tsx guarantees status === 'loaded' when this renders,
 * but we still guard against null index/validationReport for type safety.
 */

import { useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import { Actions } from './Actions.js';
import { ValidationReportPanel } from './ValidationReportPanel.js';
import { SummaryStatsPanel } from './SummaryStatsPanel.js';
import { FlagDashboardPanel } from './FlagDashboardPanel.js';
import { toFlagViewFromLocal, type SupportingRef } from './flag-view.js';
import { collectActiveExtensions } from '../../extensions/collect-active-extensions.js';
import { ActiveExtensionsCard } from '../../extensions/ActiveExtensionsCard.js';

export function OverviewView() {
  const { bundles, selectedBundleId, index, validationReport, flags } = useBundle();
  const navigate = useNavigate();

  // The panel is route-agnostic, so /local supplies its own navigation.
  const handleJumpToTimeline = useCallback(
    (ref: SupportingRef) => {
      void navigate(`/local/timeline?seq=${ref.timelineSeq}`);
    },
    [navigate],
  );

  const handleJumpToReplay = useCallback(
    (ref: SupportingRef) => {
      if (ref.event === null) return;
      void navigate(`/local/replay/${ref.event.sessionId}?event=${ref.event.globalIdx}`);
    },
    [navigate],
  );

  const flagViews = useMemo(
    () => flags.map((flag) => toFlagViewFromLocal(flag, index)),
    [flags, index],
  );

  // Session id → 1-based ordinal, so the drawer can say "Session 2" rather than
  // a truncated uuid. Bundle order is chronological.
  const sessionOrdinals = useMemo(() => {
    const bundle = bundles.find((b) => b.id === selectedBundleId) ?? bundles[0];
    const map = new Map<string, number>();
    bundle?.sessions.forEach((s, i) => map.set(s.sessionId, i + 1));
    return map;
  }, [bundles, selectedBundleId]);

  if (!index || !validationReport || bundles.length === 0) {
    return null;
  }

  // `index` is derived from selectedBundleId, so the summary bundle must match
  // it — otherwise, with multiple bundles loaded, the stats panel would show
  // bundles[0]'s manifest/sessions against a different bundle's index.
  const bundle = bundles.find((b) => b.id === selectedBundleId) ?? bundles[0]!;

  const activeExtensions = collectActiveExtensions(
    index.byKind.get('ext.snapshot') ?? [],
    index.byKind.get('ext.activate') ?? [],
  );

  return (
    <div className="container mx-auto py-8 space-y-8" data-testid="overview-view">
      <Actions />
      <ValidationReportPanel report={validationReport} />
      <SummaryStatsPanel index={index} bundle={bundle} />
      <ActiveExtensionsCard extensions={activeExtensions} />
      <FlagDashboardPanel
        flags={flagViews}
        onJumpToTimeline={handleJumpToTimeline}
        onJumpToReplay={handleJumpToReplay}
        sessionOrdinals={sessionOrdinals}
      />
    </div>
  );
}
