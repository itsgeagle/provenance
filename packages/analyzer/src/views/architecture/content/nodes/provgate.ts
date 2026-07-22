import type { ArchNode } from '../types.js';
import { GH_PROVGATE } from './links.js';

/** Nodes in the `provgate` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  adv: {
    title: 'Advance the watermark',
    body: 'The per-assignment watermark moves only after the Provenance ingest job reaches a terminal succeeded or partial state. On failure, or on any error mid-poll, it is left untouched so the next run retries.',
    invariant:
      'The watermark is an optimisation; content-hash dedup is correctness. When in doubt, forward.',
    links: [{ label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` }],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
