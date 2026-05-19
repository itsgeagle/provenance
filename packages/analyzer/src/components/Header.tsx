/**
 * Header — bundle filename, assignment id, session count, "Load different bundle".
 *
 * Hidden when no bundle is loaded (bundles.length === 0).
 */

import { useNavigate } from 'react-router-dom';
import { useBundle } from '../context/BundleContext.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

export function Header() {
  const { bundles, clearBundle } = useBundle();
  const navigate = useNavigate();

  // Hidden when no bundle is loaded.
  if (bundles.length === 0) {
    return null;
  }

  const bundle = bundles[0]!; // v1: always exactly one bundle when loaded.

  const handleLoadDifferent = () => {
    clearBundle();
    void navigate('/load');
  };

  return (
    <header
      data-testid="header"
      className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-3"
    >
      {/* Left: bundle info */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="min-w-0">
          <p
            data-testid="header-filename"
            className="truncate text-sm font-semibold"
            title={bundle.sourceFilename}
          >
            {bundle.sourceFilename}
          </p>
          <p data-testid="header-assignment-id" className="text-xs text-muted-foreground">
            Assignment: {bundle.manifest.assignment_id}
          </p>
        </div>

        <Badge variant="secondary" data-testid="header-session-count">
          {bundle.sessions.length} {bundle.sessions.length === 1 ? 'session' : 'sessions'}
        </Badge>
      </div>

      {/* Right: action */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleLoadDifferent}
        data-testid="header-load-different-btn"
      >
        Load different bundle
      </Button>
    </header>
  );
}
