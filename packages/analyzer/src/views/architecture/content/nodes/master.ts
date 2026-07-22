import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `master` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  chain: {
    title: 'Hash chain',
    body: 'Every log entry is linked to its predecessor by a SHA-256 hash taken over the previous entry’s hash concatenated with the JCS-canonical form of this entry. Editing any entry after the fact breaks every link after it, and the break is locatable to an exact sequence number.\n\nThere is exactly one chaining function per language implementation, and every code path that produces a log entry goes through it. Two chaining paths would mean two behaviours, and therefore a seam to exploit.',
    invariant:
      'Exactly one chaining function. Every log-producing path goes through it — in all four repositories.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'Recorder PRD §5.2', href: `${GH}/docs/prd.md` },
    ],
  },
  dedup: {
    title: 'Content-hash dedup',
    body: 'Before any heavy processing, ingest rejects a bundle whose (semester_id, blob_sha256) pair it has already seen. Because this check is cheap and happens first, re-sending an unchanged bundle costs almost nothing.\n\nThat property is what lets provgate treat its watermark as an optimisation rather than a correctness mechanism — if the watermark is wrong, dedup still prevents duplicate submissions.',
    invariant: 'Dedup runs before any heavy processing, never after.',
    links: [{ label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` }],
  },
  strip: {
    title: 'Source stripping',
    body: 'After every in-memory computation that needs the student’s code — statistics, all eight validation checks, and the full heuristic pass — the server deletes the source files from the bundle and stores only the signed manifest and the logs.\n\nThis is the single largest cost lever in the system, and it is why storage on a 1 TB quota is viable at cohort scale.',
    invariant:
      'Stripping happens after all computation, and never touches manifest.json or manifest.sig — the stored bundle must stay signature- and chain-verifiable.',
    links: [
      {
        label: 'strip-bundle.ts',
        href: `${GH}/packages/server/src/services/ingest/strip-bundle.ts`,
      },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = ['stu'];
