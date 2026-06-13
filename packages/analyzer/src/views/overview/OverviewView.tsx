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

import { useBundle } from '../../context/BundleContext.js';
import { Actions } from './Actions.js';
import { ValidationReportPanel } from './ValidationReportPanel.js';
import { SummaryStatsPanel } from './SummaryStatsPanel.js';
import { FlagDashboardPanel } from './FlagDashboardPanel.js';
import { collectActiveExtensions } from '../../extensions/collect-active-extensions.js';
import { ActiveExtensionsCard } from '../../extensions/ActiveExtensionsCard.js';

export function OverviewView() {
  const { bundles, index, validationReport, flags } = useBundle();

  if (!index || !validationReport || bundles.length === 0) {
    return null;
  }

  const bundle = bundles[0]!;

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
      <FlagDashboardPanel flags={flags} />
    </div>
  );
}
