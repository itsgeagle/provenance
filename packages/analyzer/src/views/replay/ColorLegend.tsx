/**
 * ColorLegend — small static legend explaining the gutter overlay colors.
 *
 * Positioned at the bottom-right of the replay view (absolute positioning
 * within the Monaco area). Not Monaco-aware — it's a pure UI legend.
 *
 * Colors match globals.css (.replay-paste-region, .replay-external-region).
 *
 * PRD ref: §7.2 (color-coded gutter).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ColorLegendProps = {
  /** Additional className for the outer wrapper. */
  className?: string;
};

// ---------------------------------------------------------------------------
// Legend items
// ---------------------------------------------------------------------------

const LEGEND_ITEMS: Array<{ label: string; color: string | undefined }> = [
  { label: 'Paste', color: 'rgba(251, 146, 60, 0.4)' }, // orange-400 tint
  { label: 'External', color: 'rgba(239, 68, 68, 0.4)' }, // red-500 tint
  { label: 'Uncolored: typed', color: undefined }, // typed regions have no decoration
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Static legend rendered in the bottom-right corner of the Monaco container.
 * The parent must set `position: relative` for absolute placement to work.
 */
export function ColorLegend({ className }: ColorLegendProps) {
  return (
    <div
      className={`absolute bottom-3 right-3 z-10 flex items-center gap-3 rounded-md border bg-background/90 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm shadow-sm ${className ?? ''}`}
      data-testid="color-legend"
      aria-label="Color legend"
    >
      {LEGEND_ITEMS.map(({ label, color }) => (
        <span key={label} className="flex items-center gap-1">
          {color !== undefined ? (
            <span
              className="inline-block h-3 w-3 rounded-sm border border-border/50"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
          ) : (
            <span
              className="inline-block h-3 w-3 rounded-sm border border-border/50 bg-transparent"
              aria-hidden="true"
            />
          )}
          {label}
        </span>
      ))}
    </div>
  );
}
