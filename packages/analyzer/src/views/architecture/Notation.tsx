/**
 * Notation — the shape / colour / line key shared by every diagram below.
 *
 * Prose and shape geometry are carried over verbatim from
 * `irb/architecture/page.template.html` §00. Every colour here is a CSS
 * variable, never a literal hex, so the key re-themes along with the
 * diagrams it explains.
 */
export function Notation() {
  return (
    <div className="arch-key">
      <div className="arch-kb">
        <div className="arch-kb-title">Shape — what it is</div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <rect
              x="1"
              y="2"
              width="32"
              height="14"
              rx="5"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>process</b> — a step that runs
          </span>
        </div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <path
              d="M17,2 L33,9 L17,16 L1,9 Z"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>decision</b> — a branch
          </span>
        </div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <path
              d="M1,5 v9 a16,4 0 0 0 32,0 v-9 a16,4 0 0 0 -32,0 a16,4 0 0 0 32,0"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>datastore</b> — Postgres, blobs, SQLite
          </span>
        </div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <path
              d="M1,2 h25 l7,7 v7 h-32 Z"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>artifact</b> — a file or record
          </span>
        </div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <path
              d="M1,2 h26 l6,7 l-6,7 h-26 Z"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>queue</b> — pg-boss
          </span>
        </div>
        <div className="arch-kr">
          <svg width="34" height="18" aria-hidden>
            <path
              d="M7,2 h20 l6,7 l-6,7 h-20 l-6,-7 Z"
              fill="var(--arch-panel)"
              stroke="var(--arch-hum)"
              strokeWidth="1.3"
            />
          </svg>
          <span>
            <b>external</b> — Gradescope, Google
          </span>
        </div>
      </div>

      <div className="arch-kb">
        <div className="arch-kb-title">Colour — which concern</div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-rec)' }} />
          <span>
            <b>Producers</b> — the three recorders
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-fmt)' }} />
          <span>
            <b>Format contract</b> — log-core &amp; its ports
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-tra)' }} />
          <span>
            <b>Transport</b> — bundle, gateway, ingest
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-srv)' }} />
          <span>
            <b>Server</b> — API, Postgres, blobs, jobs
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-ana)' }} />
          <span>
            <b>Analysis</b> — validation, heuristics
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-uix)' }} />
          <span>
            <b>Presentation &amp; keys</b> — SPA, signing
          </span>
        </div>
        <div className="arch-kr">
          <span className="arch-sw" style={{ background: 'var(--arch-hum)' }} />
          <span>
            <b>Humans &amp; externals</b>
          </span>
        </div>
      </div>

      <div className="arch-kb">
        <div className="arch-kb-title">Line — which kind of path</div>
        <div className="arch-kr">
          <svg width="42" height="12" aria-hidden>
            <line x1="1" y1="6" x2="41" y2="6" stroke="var(--arch-hum)" strokeWidth="1.6" />
          </svg>
          <span>
            <b>solid</b> — the normal path
          </span>
        </div>
        <div className="arch-kr">
          <svg width="42" height="12" aria-hidden>
            <line
              x1="1"
              y1="6"
              x2="41"
              y2="6"
              stroke="var(--arch-hum)"
              strokeWidth="1.6"
              strokeDasharray="5 3"
            />
          </svg>
          <span>
            <b>dashed</b> — optional, feedback, or skipped
          </span>
        </div>
        <div className="arch-kr">
          <svg width="42" height="12" aria-hidden>
            <line
              x1="1"
              y1="6"
              x2="41"
              y2="6"
              stroke="var(--arch-bad)"
              strokeWidth="1.6"
              strokeDasharray="5 3"
            />
          </svg>
          <span>
            <b>red</b> — a failure or rejection path
          </span>
        </div>
        <div className="arch-kr">
          <svg width="42" height="12" aria-hidden>
            <rect
              x="1"
              y="1"
              width="40"
              height="10"
              rx="4"
              fill="none"
              stroke="var(--arch-road)"
              strokeWidth="1.6"
              strokeDasharray="4 3"
            />
          </svg>
          <span>
            <b>gold dotted</b> — roadmap, not built
          </span>
        </div>
        <div className="arch-kr">
          <svg width="42" height="12" aria-hidden>
            <rect
              x="1"
              y="1"
              width="40"
              height="10"
              rx="4"
              fill="none"
              stroke="var(--arch-hum)"
              strokeWidth="2.4"
            />
          </svg>
          <span>
            <b>thick border</b> — a load-bearing node
          </span>
        </div>
      </div>
    </div>
  );
}
