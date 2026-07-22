import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { search, type Hit } from './layout.js';

type Props = {
  onPick: (hit: Hit) => void;
  onClose: () => void;
};

/** A command-palette search across every plate and every documented node.
 *  Opening with an empty query lists the plates as a table of contents. */
export function SearchPalette({ onPick, onClose }: Props) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => search(q), [q]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setI(0);
  }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('.arch-hit.sel')?.scrollIntoView({ block: 'nearest' });
  }, [i]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setI((n) => Math.min(n + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setI((n) => Math.max(n - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[i];
      if (hit) onPick(hit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="arch-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="arch-palette" role="dialog" aria-label="Search the map">
        <div className="arch-palette-in">
          <Search size={17} aria-hidden style={{ color: 'var(--ink-3)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search plates and nodes…"
            aria-label="Search plates and nodes"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="arch-palette-list" ref={listRef}>
          {hits.length === 0 ? (
            <div className="arch-palette-empty">Nothing matches “{q}”.</div>
          ) : (
            hits.map((hit, n) => (
              <div
                key={hit.addr}
                className={`arch-hit${n === i ? ' sel' : ''}`}
                onPointerEnter={() => setI(n)}
                onClick={() => onPick(hit)}
              >
                <span className="arch-hit-dot" style={{ background: `var(${hit.band})` }} />
                <div className="arch-hit-body">
                  <div className="arch-hit-title">
                    {hit.label}
                    {hit.kind === 'plate' && <em> · plate</em>}
                  </div>
                  <div className="arch-hit-snip">{hit.snippet}</div>
                </div>
                <span className="arch-hit-addr">{hit.addr}</span>
              </div>
            ))
          )}
        </div>

        <div className="arch-palette-foot">
          <span>
            <span className="k">↑</span>
            <span className="k">↓</span>navigate
          </span>
          <span>
            <span className="k">↵</span>jump
          </span>
          <span>
            <span className="k">esc</span>close
          </span>
        </div>
      </div>
    </div>
  );
}
