import { ErrorRegion } from './ErrorRegion.js';

/**
 * RouteError — full-height centered error placeholder for route guards.
 * Wraps its message in an ErrorRegion so screen readers announce the error
 * immediately (WCAG 4.1.3).
 */
export function RouteError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <ErrorRegion>
        <span className="text-sm text-destructive">{message}</span>
      </ErrorRegion>
    </div>
  );
}
