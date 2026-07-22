import { ArchitectureTheme, ArchThemeToggle } from './ArchitectureTheme.js';
import { DiagramFrame } from './DiagramFrame.js';
import { Notation } from './Notation.js';
import { SECTIONS } from './content/sections.js';

export default function ArchitectureView() {
  return (
    <ArchitectureTheme>
      <div className="arch-shell">
        <aside className="arch-toc">
          <div className="arch-brandmark">
            <svg width="22" height="22" viewBox="0 0 256 256" aria-hidden>
              <defs>
                <clipPath id="archmark">
                  <rect x="96" y="50" width="64" height="78" />
                </clipPath>
              </defs>
              <rect
                x="50"
                y="74"
                width="96"
                height="104"
                rx="34"
                fill="none"
                stroke="var(--arch-ink)"
                strokeWidth="18"
              />
              <rect
                x="110"
                y="74"
                width="96"
                height="104"
                rx="34"
                fill="none"
                stroke="var(--arch-brand)"
                strokeWidth="18"
              />
              <g clipPath="url(#archmark)">
                <rect
                  x="50"
                  y="74"
                  width="96"
                  height="104"
                  rx="34"
                  fill="none"
                  stroke="var(--arch-ink)"
                  strokeWidth="18"
                />
              </g>
            </svg>
            <h1>Provenance</h1>
          </div>
          <nav aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                <b>{s.num}</b>
                {s.title}
              </a>
            ))}
          </nav>
          <ArchThemeToggle />
        </aside>

        <main className="arch-main">
          <header className="arch-mast">
            <p className="arch-kick">Four repositories · Three recorders · One signed format</p>
            <h2>System architecture</h2>
            <p className="arch-deck">
              Provenance answers “how did this code come to exist?” rather than “does this code look
              copied?” — recording the process of authorship into a hash-chained, cryptographically
              signed log while a student works, then giving course staff a way to review thousands
              of those logs at scale.
            </p>
          </header>

          <Notation />

          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="arch-section">
              <div className="arch-section-hd">
                <span className="arch-num">{s.num}</span>
                <h3>{s.title}</h3>
              </div>
              <p className="arch-framing">{s.framing}</p>
              <DiagramFrame id={s.diagram} title={s.title} svg={s.svg} />
            </section>
          ))}
        </main>
      </div>
    </ArchitectureTheme>
  );
}
