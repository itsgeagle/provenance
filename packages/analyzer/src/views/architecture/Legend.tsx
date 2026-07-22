const BANDS: [string, string][] = [
  ['--rec', 'Recorders'],
  ['--fmt', 'Format contract'],
  ['--tra', 'Transport'],
  ['--srv', 'Server'],
  ['--ana', 'Analysis'],
  ['--uix', 'Presentation'],
  ['--hum', 'Humans'],
  ['--road', 'Roadmap'],
];

/** The notation key. Colour is concern, shape is what a node is, line style is
 *  what kind of path an edge is. */
export function Legend() {
  return (
    <div className="arch-legend" role="region" aria-label="Legend">
      <h4>Colour is concern</h4>
      <div className="arch-legend-grid">
        {BANDS.map(([v, label]) => (
          <div className="arch-legend-row" key={v}>
            <span className="arch-legend-sw" style={{ background: `var(${v})` }} />
            {label}
          </div>
        ))}
      </div>
      <hr />
      <div className="arch-legend-line">
        <svg width="34" height="12" aria-hidden>
          <line x1="1" y1="6" x2="33" y2="6" stroke="var(--ink-2)" strokeWidth="1.6" />
        </svg>
        the normal path
      </div>
      <div className="arch-legend-line">
        <svg width="34" height="12" aria-hidden>
          <line
            x1="1"
            y1="6"
            x2="33"
            y2="6"
            stroke="var(--bad)"
            strokeWidth="1.6"
            strokeDasharray="5 3"
          />
        </svg>
        a failure or rejection
      </div>
      <div className="arch-legend-line">
        <svg width="34" height="12" aria-hidden>
          <rect
            x="1"
            y="1"
            width="32"
            height="10"
            rx="3"
            fill="none"
            stroke="var(--road)"
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        </svg>
        roadmap, not built
      </div>
    </div>
  );
}
