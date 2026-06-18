/**
 * Global protected-mode banner.
 *
 * Rendered at the very top of AppShell (below ViewAsBanner) when /me returns
 * a user whose `protected` flag is true. Non-dismissable — the flag can only
 * be toggled by a different superadmin from /admin/users.
 *
 * Intentionally loud (amber) so the viewer is always aware that student
 * identities have been masked.
 */

import { useMe } from '../../api/queries.js';

export function ProtectedModeBanner() {
  const { data: me } = useMe();
  if (!me?.user.protected) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-300 bg-amber-100 px-4 py-2 text-xs font-medium text-amber-900"
      data-testid="protected-mode-banner"
    >
      🔒 Protected mode — student identities are masked
    </div>
  );
}
