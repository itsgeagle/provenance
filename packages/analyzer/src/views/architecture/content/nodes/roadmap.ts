import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `roadmap` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Shipped seams the roadmap attaches to ─────────────────────────────────
  vectors: {
    title: 'Conformance vectors + the log-core format contract',
    body: 'The thing a recorder has to get right is not a codebase, it is a format: the envelope, the JCS canonicalization, the hash chain, the ed25519 and session-key framing. That format is pinned as language-neutral test vectors — hash chains, signatures, a golden bundle — exported by one script that is the single source of truth for cross-language parity. Regenerating it reproduces the committed fixtures byte-for-byte, which is the drift check proving the export is faithful.\n\nThat is what makes a new recorder a bounded job rather than an open one. Three implementations already consume these vectors from three unrelated runtimes — TypeScript, Kotlin, Lua — so "add a host" means porting the format layer against a fixed target and re-deriving the editor wiring on top, not inventing anything the analyzer then has to be taught to read. A recorder that passes the vectors is one the existing analyzer already understands.',
    invariant:
      'The vectors are the contract. A new recorder passes them; it never negotiates a format change to make itself easier.',
    links: [
      {
        label: 'export-conformance-vectors.ts',
        href: `${GH}/tools/export-conformance-vectors.ts`,
      },
      { label: 'hash-chain.test.ts', href: `${GH}/packages/log-core/src/hash-chain.test.ts` },
    ],
  },
  gsmod: {
    title: 'The one module that knows Gradescope exists',
    body: 'Every fact about Gradescope — how its export is shaped, how submission_metadata.yml names submitters, how a folder-per-submission is rebuilt into a bundle zip — is confined to one ingest module on the server and, in the sync gateway, to one client behind a Protocol port that the engine depends on abstractly. Nothing downstream of the rebuild knows where the bytes came from.\n\nThat confinement is the whole reason a second ingest source is tractable: the pipeline it feeds — match, create, stats, validation, heuristics — takes a bundle zip and a submitter, and does not care which upstream produced them. A new source is another adapter that ends at the same handoff, not a change to anything after it.',
    links: [
      {
        label: 'parse-export.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/parse-export.ts`,
      },
      { label: 'ports.py', href: `${GH_PROVGATE}/src/provgate/sync/ports.py` },
    ],
  },
  frontend: {
    title: 'The core already sits behind a frontend-agnostic boundary',
    body: 'provgate’s command line describes itself, accurately, as a thin frontend over the core. The parts that do the work — the encrypted class store, the sync engine — are reached through a repository and a set of Protocol ports, with concrete dependencies assembled in one wiring module the CLI calls into. The CLI contributes argument parsing and output formatting and nothing else.\n\nSo a second frontend is not a rewrite, it is a second caller of the same store and engine. The commands that exist — register a class, list run history — are already the screens a web GUI would open with, because the CLI verbs are a faithful projection of what the core can do. The store and sync layers move across unchanged; only the presentation is new.',
    links: [
      { label: 'main.py', href: `${GH_PROVGATE}/src/provgate/cli/main.py` },
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
    ],
  },
  tenancy: {
    title: 'The hierarchy already models more than one institution',
    body: 'Courses contain semesters contain memberships, and every access decision is made against the specific semester in the request path. Nothing in that shape assumes a single school — two departments, or two universities, could be distinct course trees in the same database and the authorization logic would already keep them apart, because it never reasons above the semester.\n\nWhat is genuinely single-tenant is narrower and lives at the edges: the hosted-domain allowlist and the absence of any UI or isolation guarantees for running distinct tenants side by side. The data model is not the blocker; the boundary work is. That is why multi-institution is a short step in the diagram and not a redesign — the hard structural decision was made when access was scoped per semester rather than globally.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: 'authorize.ts', href: `${GH}/packages/server/src/auth/authorize.ts` },
    ],
  },

  // ── Roadmap — not built ───────────────────────────────────────────────────
  jupyter: {
    title: 'JupyterLab recorder — not built',
    body: 'This is the highest-value fourth host because notebooks are where a great deal of introductory coursework actually happens, and because a notebook offers a provenance signal no text editor can: execution history — which cells were run, in what order, against what output. A recorder that captured it would be reasoning over evidence the current three cannot see.\n\nIt attaches to the vectors seam like any recorder, but it is also the first host that would genuinely stress the event model. The whole format is built around a file and edits to it; a notebook’s unit is a cell, and cell-level rather than file-level editing is the thing that would force a real decision about how doc.change maps onto a notebook before a single line of it should be written. Nothing here is built.',
    links: [
      {
        label: 'export-conformance-vectors.ts (the seam)',
        href: `${GH}/tools/export-conformance-vectors.ts`,
      },
    ],
  },
  emacs: {
    title: 'Emacs recorder — not built',
    body: 'A fourth port of the same contract, and the least speculative item on the board precisely because the path is now worn: three recorders across three runtimes have already shown the format layer travels. The concrete precedent is the Neovim recorder, which had to implement the ed25519 and cipher framing in pure Lua with no native dependency — an Emacs port faces the identical problem in elisp, and it is a solved-shape problem rather than an open one.\n\nWhat it does not have is a distinguishing signal of its own the way a notebook does, which is why it ranks below JupyterLab despite being easier. It is a straightforward consumer of the vectors with an editor-wiring layer on top. Not built.',
    links: [
      {
        label: 'hash-chain.test.ts (the pinned format)',
        href: `${GH}/packages/log-core/src/hash-chain.test.ts`,
      },
    ],
  },
  okpy: {
    title: 'okpy integration — not built',
    body: 'A second ingest source alongside Gradescope, attaching to the seam that already isolates everything Gradescope-specific to one module. Because the downstream pipeline consumes a rebuilt bundle zip and a resolved submitter and asks nothing about provenance of the upload, an okpy source would be another adapter that terminates at that same handoff — parse okpy’s export shape, rebuild a bundle per submission, hand it to the identical match-and-analyse path.\n\nThe reason it is a sibling and not a rewrite is that content-hash dedup and the roster match already sit below the source boundary, so a second source inherits idempotency and student-matching for free. It does not exist yet.',
    links: [
      { label: 'ports.py (the port shape)', href: `${GH_PROVGATE}/src/provgate/sync/ports.py` },
      {
        label: 'parse-export.ts (the Gradescope sibling)',
        href: `${GH}/packages/server/src/services/ingest/gradescope/parse-export.ts`,
      },
    ],
  },
  pweb: {
    title: 'provgate web GUI — not built',
    body: 'A web front end for the sync gateway, reusing the store and sync layers exactly as they are because the CLI already proved they sit behind a frontend-agnostic boundary. The natural first screens are the CLI verbs made visual: registering a class and reading run history, both of which are already backed by repository methods the CLI merely wraps.\n\nWhat makes it cheap is specifically that the engine depends on Protocol ports and its dependencies are assembled in one wiring module, so a web frontend swaps the presentation and the entry point while the encrypted store, the class model and the per-assignment sync loop carry over untouched. This is a plan, not a shipped feature.',
    links: [
      { label: 'main.py (the CLI it mirrors)', href: `${GH_PROVGATE}/src/provgate/cli/main.py` },
      {
        label: 'repository.py (carried over)',
        href: `${GH_PROVGATE}/src/provgate/store/repository.py`,
      },
    ],
  },
  multi: {
    title: 'Multi-institution tenancy — not built',
    body: 'Running Provenance for more than one department or school. The data model is already there — the course/semester/membership hierarchy scopes every authorization decision below the semester, so distinct institutions could coexist as separate course trees without the access logic confusing them.\n\nThe unbuilt part is the boundary, not the schema. The hosted-domain allowlist is a single configured set rather than a per-tenant one, and there is no UI or hardened isolation for administering separate tenants side by side. Those are the edges that would have to be built before this could be claimed; today it is a consequence the model permits, not a feature that exists.',
    links: [
      { label: 'env.ts (the single allowlist)', href: `${GH}/packages/server/src/config/env.ts` },
      { label: 'schema.ts (the hierarchy)', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },

  // ── Excluded on principle ─────────────────────────────────────────────────
  excluded: {
    title: 'Excluded on principle, not on effort',
    body: 'These are not unbuilt features waiting for time; they are things the product refuses to do, and the refusals are load-bearing.\n\nLLM review of student code is out because a defensible integrity finding reasons over the process — pastes, external edits, timing — not over the meaning of the code. Any LLM feature here reads the event log; "this code looks AI-written" is a conclusion a hearing cannot use and a reviewer cannot argue with. Code-similarity classifiers are excluded for the same reason: a similarity score over source is a verdict about the code, and this system deliberately produces evidence a human ranks, never a verdict.\n\nNetwork telemetry from the recorder is excluded because the recorder is offline by design — the log is sealed and travels inside the one bundle that ever leaves the machine, and a background channel would be both a privacy liability and a thing students could not verify by reading the source. Keystroke-level OS hooks are out because the unit of evidence is a document diff, not a key; hooks would capture far more than the assignment and record outside the editor entirely. And obfuscating the recorder is refused on purpose: students will read it, the protocol is assumed public, and security that depends on nobody looking is not security.',
    invariant:
      'Every heuristic reasons over process evidence, never over the meaning of the student’s code.',
    links: [
      { label: 'Recorder PRD (non-goals)', href: `${GH}/docs/prd.md` },
      { label: 'heuristics catalogue', href: `${GH}/docs/heuristics.md` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
