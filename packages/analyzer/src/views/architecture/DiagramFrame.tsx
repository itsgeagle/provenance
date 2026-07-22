import { useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import { DiagramCanvas } from './DiagramCanvas.js';
import { NodeDetailPanel } from './NodeDetailPanel.js';

type Props = { id: string; title: string; svg: string };

export function DiagramFrame({ id, title, svg }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  return (
    <figure className="arch-frame">
      <figcaption className="arch-frame-bar">
        <span className="arch-frame-title">{title}</span>
        <button
          type="button"
          className="arch-btn"
          aria-label="Full screen"
          onClick={() => setFull(true)}
        >
          <Maximize2 size={13} aria-hidden />
        </button>
      </figcaption>

      <div className="arch-frame-body">
        <DiagramCanvas svg={svg} diagramId={id} selected={sel} onSelect={setSel} />
        <NodeDetailPanel diagramId={id} node={sel} onClose={() => setSel(null)} />
      </div>

      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="max-w-[96vw] p-0">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div className="arch-root" data-arch-theme-inherit>
            <DiagramCanvas svg={svg} diagramId={id} selected={sel} onSelect={setSel} />
            <NodeDetailPanel diagramId={id} node={sel} onClose={() => setSel(null)} />
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}
