import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { NODES } from './content/nodes.js';
import { nodeKey } from './content/types.js';

type Props = {
  diagram: string;
  node: string | null;
  onClose: () => void;
};

/** The detail for a selected node: prose, its invariant if it has one, and
 *  links into the real source. Slides in from the right of the canvas. */
export function NodeDetailPanel({ diagram, node, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (node) ref.current?.focus();
  }, [node, diagram]);

  if (!node) return null;
  const detail = NODES[nodeKey(diagram, node)];

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
        <span className="arch-detail-addr">
          <b>{diagram}</b>:{node}
        </span>
        <button
          type="button"
          className="arch-detail-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="arch-detail-scroll">
        {detail ? (
          <>
            <h3>{detail.title}</h3>
            {detail.body.split('\n\n').map((para) => (
              <p key={para.slice(0, 24)}>{para}</p>
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
            <p className="arch-muted">This node is a plain label. Its name is the whole story.</p>
          </>
        )}
      </div>
    </aside>
  );
}
