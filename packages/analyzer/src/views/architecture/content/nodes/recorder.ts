import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `recorder` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  expected: {
    title: 'Expected-content registry',
    body: 'The recorder maintains a model of what it believes every tracked file contains, updated after each edit it observes. External-change detection compares the on-disk hash against that model.\n\nThe direction matters and is easy to reverse: the model is the source of truth, the disk is what you check against it. Reversing it produces a recorder that flags every ordinary save and misses every real evasion.',
    invariant:
      'The expected-content model is the source of truth; the on-disk hash is compared to it.',
    links: [
      {
        label: 'expected-content.ts',
        href: `${GH}/packages/recorder/src/state/expected-content.ts`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
