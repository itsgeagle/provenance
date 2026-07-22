import { useEffect, useRef } from 'react';
import type { Plate as PlateData } from './layout.js';

type Props = {
  plate: PlateData;
  active: boolean;
  dim: boolean;
  selectedNode: string | null;
  /** Enter/Space on a focused node activates it (pointer clicks are handled by
   *  the canvas via delegation). */
  onActivateNode: (diagram: string, node: string) => void;
};

/**
 * One diagram plate on the canvas: an engineering titleblock over the injected
 * SVG. The SVG lives outside React's tree, so node affordances (focusable,
 * labelled, selection highlight) are stamped on with effects.
 */
export function Plate({ plate, active, dim, selectedNode, onActivateNode }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Make every node focusable and keyboard-activatable.
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const g = (ke.target as Element | null)?.closest?.('g.node');
      const name = g?.querySelector('title')?.textContent;
      if (!name) return;
      ke.preventDefault();
      onActivateNode(plate.name, name);
    };
    host.querySelectorAll('g.node').forEach((g) => {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      const name = g.querySelector('title')?.textContent ?? '';
      g.setAttribute('aria-label', `${name} — open details`);
    });
    host.addEventListener('keydown', onKey);
    return () => host.removeEventListener('keydown', onKey);
  }, [plate.name, onActivateNode]);

  // Reflect the selected node onto the SVG markup.
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    host.querySelectorAll('g.node').forEach((g) => {
      const name = g.querySelector('title')?.textContent ?? '';
      if (name === selectedNode) g.setAttribute('data-selected', 'true');
      else g.removeAttribute('data-selected');
    });
  }, [selectedNode]);

  return (
    <div
      className={`arch-plate${active ? ' active' : ''}${dim ? ' dim' : ''}`}
      data-diagram={plate.name}
      style={{ left: plate.x, top: plate.y, width: plate.w }}
    >
      <div className="arch-titleblock" data-focus-plate={plate.name}>
        <span className="arch-plate-no">{plate.no}</span>
        <div className="arch-titleblock-text">
          <div className="arch-plate-title">{plate.title}</div>
          <div className="arch-plate-cap">{plate.caption}</div>
        </div>
        <span className="arch-plate-focus">Focus</span>
      </div>
      <div
        className="arch-plate-body"
        ref={bodyRef}
        /* Build-time asset from tools/architecture/build_diagrams.py, not user input. */
        dangerouslySetInnerHTML={{ __html: plate.svg }}
      />
    </div>
  );
}
