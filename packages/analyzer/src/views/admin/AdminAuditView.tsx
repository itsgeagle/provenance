/**
 * V45 — /admin/audit
 *
 * Audit log list. Filters by action substring and date range (since/until).
 * The server endpoint already supports semester_id / actor_user_id filters too;
 * this UI exposes the most common ones (action + range) since the others are
 * typically followed from the per-user / per-semester pages.
 */

import { useState } from 'react';
import { AdminLayout } from './AdminLayout.js';
import { useAdminAudit } from '../../api/queries.js';

export function AdminAuditView() {
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const query = useAdminAudit({
    ...(action !== '' ? { action } : {}),
    ...(since !== '' ? { since: new Date(`${since}T00:00:00Z`).toISOString() } : {}),
    ...(until !== '' ? { until: new Date(`${until}T23:59:59Z`).toISOString() } : {}),
  });

  return (
    <AdminLayout>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs text-gray-600">
          Action contains
          <input
            type="text"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. admin."
            className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            data-testid="audit-action-input"
          />
        </label>
        <label className="text-xs text-gray-600">
          Since
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            data-testid="audit-since-input"
          />
        </label>
        <label className="text-xs text-gray-600">
          Until
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            data-testid="audit-until-input"
          />
        </label>
      </div>

      {query.isLoading && (
        <div className="py-8 text-center text-sm text-gray-600">Loading audit log…</div>
      )}
      {query.error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="audit-error">
          Failed to load audit log.
        </div>
      )}

      {!query.isLoading && !query.error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Actor</th>
                <th className="px-3 py-2 text-left">Target</th>
                <th className="px-3 py-2 text-left">Semester</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {query.data?.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-600">
                    No audit rows match.
                  </td>
                </tr>
              ) : (
                query.data?.items.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-[10px] text-gray-500 whitespace-nowrap">
                      {new Date(row.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-700">
                      {row.actor_user_id ?? row.actor_token_id ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="text-gray-500">{row.target_type}</span>{' '}
                      <span className="font-mono text-[10px]">{row.target_id}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-500">
                      {row.semester_id ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-600">
                      {JSON.stringify(row.detail)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
