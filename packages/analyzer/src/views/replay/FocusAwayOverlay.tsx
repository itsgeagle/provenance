/**
 * FocusAwayOverlay — a persistent red overlay shown over the replay code pane
 * while the playhead is inside a "focused away from window" span (recorder
 * PRD §4.4 focus.change). Covers the code pane only (not the transport bar), is
 * non-interactive (pointer-events: none), and mirrors the absolute-overlay
 * pattern used by ColorLegend.
 */

type FocusAwayOverlayProps = {
  /** Optional reason recorded with the focus.change (e.g. "window", "tab"). */
  reason: string | null;
};

export function FocusAwayOverlay({ reason }: FocusAwayOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-red-500/15"
      data-testid="focus-away-overlay"
    >
      <div className="mt-4 rounded-md bg-red-600/90 px-3 py-1.5 text-xs font-medium text-white shadow">
        Focus changed — student focused away from the window
        {reason !== null ? ` (${reason})` : ''}
      </div>
    </div>
  );
}
