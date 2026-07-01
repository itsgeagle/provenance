/**
 * ValidationReportPanel — displays the 8 validation check results.
 *
 * PRD §7.2, §5.4.
 *
 * Each row shows a status icon, the check label, and optional detail text.
 * Failing checks with supportingSeqs are clickable and navigate to
 * /timeline?seq=<sessionId>:<seq>.
 */

import { CheckCircle2, XCircle, Circle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { cn } from '@/lib/utils.js';
import type {
  ValidationReport,
  ValidationCheck,
} from '@provenance/analysis-core/validation/check-types.js';

interface ValidationReportPanelProps {
  report: ValidationReport;
}

const overallVariant = {
  pass: 'bg-green-100 text-green-800 border-green-200',
  warn: 'bg-amber-100 text-amber-800 border-amber-200',
  fail: 'bg-red-100 text-red-800 border-red-200',
} as const;

const overallLabel = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
} as const;

function CheckRow({ check }: { check: ValidationCheck }) {
  const navigate = useNavigate();

  const isClickable =
    check.status === 'fail' &&
    check.supportingSeqs !== undefined &&
    check.supportingSeqs.length > 0;

  const handleClick = () => {
    if (!isClickable || !check.supportingSeqs) return;
    const first = check.supportingSeqs[0]!;
    void navigate(`/local/timeline?seq=${first.sessionId}:${first.seq}`);
  };

  const rowBase = 'flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors';
  const statusClass =
    check.status === 'pass'
      ? 'bg-green-50'
      : check.status === 'fail'
        ? 'bg-red-50'
        : 'bg-transparent';
  const clickableClass = isClickable
    ? 'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-ring'
    : '';

  const icon =
    check.status === 'pass' ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
    ) : check.status === 'fail' ? (
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
    ) : (
      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      className={cn(rowBase, statusClass, clickableClass)}
      onClick={isClickable ? handleClick : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
      data-testid={`check-row-${check.id}`}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm font-medium',
            check.status === 'pass' && 'text-green-700',
            check.status === 'fail' && 'text-red-700',
            check.status === 'skipped' && 'text-muted-foreground',
          )}
        >
          {check.label}
        </p>
        {check.detail !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
        )}
      </div>
      {check.status === 'skipped' && (
        <span className="shrink-0 text-xs text-muted-foreground">skipped</span>
      )}
    </div>
  );
}

export function ValidationReportPanel({ report }: ValidationReportPanelProps) {
  return (
    <Card data-testid="validation-report-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Validation Report</CardTitle>
          <span
            data-testid="overall-badge"
            className={cn(
              'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
              overallVariant[report.overall],
            )}
          >
            {overallLabel[report.overall]}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {report.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </CardContent>
    </Card>
  );
}
