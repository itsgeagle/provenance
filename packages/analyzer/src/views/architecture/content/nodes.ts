/**
 * Node metadata barrel.
 *
 * Content is authored per diagram in `nodes/<diagram>.ts`, keyed by BARE dot
 * node name. This barrel prefixes each key with its diagram id, so a key can
 * never disagree with the file it lives in — the `diagram:` half is derived,
 * not typed by hand.
 *
 * `nodes.coverage.test.ts` asserts that every node in every committed SVG has
 * either a `nodes` entry or a `noDetail` entry, and that no entry survives for
 * a node that no longer exists.
 */
import type { ArchNode } from './types.js';
import * as analysis from './nodes/analysis.js';
import * as chain from './nodes/chain.js';
import * as deploy from './nodes/deploy.js';
import * as ecosystem from './nodes/ecosystem.js';
import * as er from './nodes/er.js';
import * as ingest from './nodes/ingest.js';
import * as master from './nodes/master.js';
import * as provgate from './nodes/provgate.js';
import * as readpath from './nodes/readpath.js';
import * as recorder from './nodes/recorder.js';
import * as roadmap from './nodes/roadmap.js';
import * as staff from './nodes/staff.js';
import * as state from './nodes/state.js';

const GROUPS = {
  analysis,
  chain,
  deploy,
  ecosystem,
  er,
  ingest,
  master,
  provgate,
  readpath,
  recorder,
  roadmap,
  staff,
  state,
} as const;

export const NODES: Record<string, ArchNode> = Object.fromEntries(
  Object.entries(GROUPS).flatMap(([d, g]) =>
    Object.entries(g.nodes).map(([n, v]) => [`${d}:${n}`, v] as const),
  ),
);

export const NO_DETAIL: ReadonlySet<string> = new Set(
  Object.entries(GROUPS).flatMap(([d, g]) => g.noDetail.map((n) => `${d}:${n}`)),
);
