/**
 * ActiveExtensionsCard — presentational card listing the third-party extensions
 * that were active during a session. AI assistants get a red "AI" badge with a
 * reason tooltip. Used by both the v3 and v2 overview pages.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Badge } from '@/components/ui/badge.js';
import type { ActiveExtension } from './collect-active-extensions.js';

export function ActiveExtensionsCard({ extensions }: { extensions: ActiveExtension[] }) {
  return (
    <Card data-testid="active-extensions-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Active extensions</CardTitle>
      </CardHeader>
      <CardContent>
        {extensions.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="active-extensions-empty">
            No third-party extensions were active.
          </p>
        ) : (
          <ul className="space-y-1">
            {extensions.map((ext) => (
              <li
                key={ext.id}
                className="flex items-center gap-2 text-sm py-1"
                data-testid={`extension-row-${ext.id}`}
              >
                <code className="text-gray-700">{ext.id}</code>
                {ext.version && <span className="text-gray-400 text-xs">{ext.version}</span>}
                {ext.isAi && (
                  <Badge
                    variant="destructive"
                    className="ml-auto"
                    title={ext.aiReason}
                    data-testid={`extension-ai-badge-${ext.id}`}
                  >
                    AI
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
