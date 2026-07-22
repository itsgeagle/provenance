import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `staff` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  hd: {
    title: 'Hosted-domain claim check',
    body: 'Authentication succeeds only when the Google ID token’s hd claim matches AUTH_ALLOWED_HOSTED_DOMAINS. It is the primary access control on the analyzer — the single check keeping non-institutional Google accounts out.',
    invariant: 'Do not loosen the hd check.',
    links: [{ label: 'auth', href: `${GH}/packages/server/src/auth` }],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
