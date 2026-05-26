/**
 * V45 — Global view-as banner.
 *
 * Rendered at the very top of AppShell when /me returns a non-null view_as
 * field. Shows who's being impersonated and offers a one-click Exit button.
 * After Exit, /me is refetched (mutation clears the React Query cache).
 *
 * The banner is intentionally loud (amber) so a superadmin can't easily
 * forget they're in impersonation mode.
 */

import { useExitViewAs, useMe } from '../../api/queries.js';

export function ViewAsBanner() {
  const { data: me } = useMe();
  const { mutate: exitViewAs, isPending } = useExitViewAs();

  if (me === undefined) return null;
  if (me.principal_kind !== 'session') return null;
  if (me.view_as === null) return null;

  const target = me.view_as.user;
  const label =
    target.display_name !== null ? `${target.display_name} (${target.email})` : target.email;

  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-xs text-amber-900"
      data-testid="view-as-banner"
      role="status"
    >
      <span>
        <strong>Viewing as</strong> {label}. Read-only — writes are blocked while in view-as.
      </span>
      <button
        onClick={() => exitViewAs()}
        disabled={isPending}
        className="rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
        data-testid="view-as-exit"
      >
        {isPending ? 'Exiting…' : 'Exit view-as'}
      </button>
    </div>
  );
}
