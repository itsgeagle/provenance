import { StatusRegion } from './StatusRegion.js';

/**
 * RouteLoading — full-height centered loading placeholder for route guards
 * and lazy-loaded routes. Wraps its label in a StatusRegion so screen
 * readers announce the loading state (WCAG 4.1.3).
 */
export function RouteLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <StatusRegion>
        <span className="text-sm text-gray-600">{label}</span>
      </StatusRegion>
    </div>
  );
}
