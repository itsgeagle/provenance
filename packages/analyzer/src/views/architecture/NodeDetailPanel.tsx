import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { NODES } from './content/nodes.js';
import { nodeKey } from './content/types.js';

type Props = { diagramId: string; node: string | null; onClose: () => void };

export function NodeDetailPanel({ diagramId, node, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (node) ref.current?.focus();
  }, [node]);

  if (!node) return null;
  const detail = NODES[nodeKey(diagramId, node)];

  return (
    <aside
      ref={ref}
      className="arch-detail"
      tabIndex={-1}
      role="region"
      aria-label="Node details"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="arch-detail-bar">
        <span className="arch-detail-eyebrow">{diagramId}</span>
        <button type="button" className="arch-btn" aria-label="Close details" onClick={onClose}>
          <X size={13} aria-hidden />
        </button>
      </div>

      {detail ? (
        <>
          <h3>{detail.title}</h3>
          {detail.body.split('\n\n').map((p) => (
            <p key={p.slice(0, 24)}>{p}</p>
          ))}
          {detail.invariant && (
            <div className="arch-invariant">
              <span>Invariant</span>
              <p>{detail.invariant}</p>
            </div>
          )}
          {detail.links && detail.links.length > 0 && (
            <ul className="arch-links">
              {detail.links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <h3>{node}</h3>
          <p className="arch-muted">
            No additional detail is authored for this node — its label is the whole story.
          </p>
        </>
      )}
    </aside>
  );
}
