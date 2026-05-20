# Provenance

**A CS 61A academic-integrity telemetry and analysis system.**

Provenance has two halves that share one artifact:

1. **Provenance Recorder** — a VS Code extension that runs while a student works on an assignment and produces a tamper-evident log of how the code came into existence.
2. **Provenance Analyzer** — a web app used by course staff to inspect those logs: a replay UI for manual review, plus an automated heuristics engine that flags suspicious patterns for human attention.

The full design lives in [`docs/prd.md`](docs/prd.md). Code conventions for working in this repo are in [`CLAUDE.md`](CLAUDE.md).

## Status

| Component           | Status                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/log-core` | **Complete** — event types, JCS canonicalization, hash chain, validator, ndjson serialization, bundle and manifest shapes, ed25519 manifest verification. 125 unit tests.                                                                                                                                                                                                              |
| `packages/recorder` | **v1.1 complete** — all PRD §4 event types, three-signal paste detection, external-change detection, per-session signing keypair, signed checkpoints, chain recovery, bundle seal, disk-full degraded mode, initial-content capture on `doc.open` (v1.1). 255 unit tests + integration tests against real VS Code.                                                                     |
| `packages/analyzer` | **v2 complete** — bundle load + validation, multi-bundle + `/compare` view, overview, raw timeline (virtualized), Monaco replay (real-time playback at recorded event spacing, gutter decorations, hover attribution, jumps), full heuristic suite (process-shape + environment + integrity + cross-submission), markdown + PDF findings export. 816 unit tests. Static hosting ready. |

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the phase-by-phase build history.

## Quickstart for developers

Requires Node 22+ (for `--experimental-strip-types`) and npm 10+.

```sh
git clone <repo>
cd provenance
npm install
npm run build && npm run typecheck && npm run lint && npm run test
```

To run the recorder against the bundled test workspace, open this repo in VS Code and press F5 (or pick **"Run Recorder Extension"** in the Run & Debug panel). A second VS Code window opens with `test-workspace/` loaded; the status bar shows "CS 61A: recording".

For richer instructions — including how to read the live log, run the integration tests against a real VS Code, and exercise the bundle-seal flow — see [`packages/recorder/README.md`](packages/recorder/README.md).

To run the analyzer in development, start the dev server:

```sh
npm run dev --workspace=packages/analyzer
```

Then drop a `.slog` bundle in the load view. For a static build ready to host, see [`packages/analyzer/README.md`](packages/analyzer/README.md).

## Repo layout

```
provenance/
├── docs/
│   ├── prd.md                 # product spec — source of truth for behavior
│   └── implementation-plan.md # phased plan that built the v1 recorder
├── packages/
│   ├── log-core/              # shared event types, hash chain, format
│   ├── recorder/              # the VS Code extension (v1 complete)
│   └── analyzer/              # web app (v2 complete)
├── tools/                     # dev scripts (key generation, manifest signing)
├── test-workspace/            # sample student workspace used for dev & integration tests
├── CLAUDE.md                  # repo conventions
└── package.json               # npm workspace root
```

## Architecture rules (enforced)

- `packages/log-core` has zero runtime dependencies on VS Code, Node-only APIs, or the DOM. It's pure TypeScript that runs in any JS environment. An ESLint `no-restricted-imports` rule on `packages/log-core/**/*.ts` rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, `crypto` imports.
- `packages/recorder` depends on `log-core`, `vscode`, and a small fixed set of approved libraries (`@noble/ed25519`, `@noble/hashes`, `@noble/ciphers`, `canonicalize`, `jszip`). The packaged VSIX is ESM (requires VS Code ≥ 1.94).
- The log file format is the contract between recorder and analyzer. It's specified in PRD §5 and pinned with test vectors in `packages/log-core/src/hash-chain.test.ts`.

## Common commands

| Command                                                  | What it does                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                                          | TypeScript build for both packages.                                               |
| `npm run test`                                           | Vitest unit tests across all workspaces (~1200 total).                            |
| `npm run typecheck`                                      | `tsc --noEmit` across the workspace.                                              |
| `npm run lint`                                           | ESLint + Prettier check.                                                          |
| `npm run package:recorder`                               | Build the VSIX (`.vsix` file) for local installation.                             |
| `npm run test:integration --workspace packages/recorder` | Download VS Code 1.120 and run integration tests against the real Extension Host. |
| `npm run bench --workspace packages/recorder`            | Run the SessionWriter perf benchmark (p99 should be << 1ms).                      |

## Course staff: key & manifest workflow

The recorder verifies every `.cs61a` manifest against an ed25519 public key embedded in the extension. The keypair is generated **offline** on a secured machine; the private key never enters the repo.

**Generate the course keypair** (once, on a secured machine):

```sh
node --experimental-strip-types tools/generate-course-keypair.ts /Volumes/SECURE/cs61a-fa26.json
```

The public key is printed to stdout (paste into a clipboard or pipe into the production build). The private key is written to the chosen path with mode `0600`. Back it up to physical media.

**Sign a per-assignment manifest** (every time a new assignment is released):

```sh
PROVENANCE_COURSE_KEYPAIR_PATH=/Volumes/SECURE/cs61a-fa26.json \
  node --experimental-strip-types tools/sign-cs61a-manifest.ts /path/to/assignment-starter/.cs61a
```

The script strips any existing signature, canonicalizes the remaining fields (via JCS), signs with the private key, and writes the updated `.cs61a` back to disk.

**Produce a production VSIX** with the course public key embedded:

```sh
PROVENANCE_COURSE_PUBLIC_KEY_HEX=<64-hex-from-generate-step> \
  npm run build:prod --workspace packages/recorder
```

`build:prod` embeds the production key, builds, packages a VSIX, then restores the source file so further local work uses the dev key. The script refuses to run if the env var is missing, malformed, or matches the dev key — so a misconfigured release can never silently ship a dev VSIX.

See [`packages/recorder/README.md`](packages/recorder/README.md) for the full security model and what the recorder defends against.

## License

MIT. See `LICENSE`.
