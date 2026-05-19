# Regenerating the Real-Recorder Fixture

This document explains how to produce (or re-produce) the real-fixture ZIP used by
`test/integration/load-and-validate.test.ts`. The fixture is a bundle that the
Provenance Recorder produced against the `test-workspace/` directory — it proves
that the Analyzer's load + validation + heuristics pipeline works end-to-end on
real recorder output, not just on synthetically-built bundles.

## When to regenerate

- After any change to `packages/log-core/` that modifies the log format or chain
  computation (requires a format version bump and explicit sign-off per CLAUDE.md).
- After any change to `packages/recorder/` that alters what events are emitted.
- After the initial setup of a new assignment test-workspace.

## Prerequisites

1. VS Code with the Provenance Recorder extension installed (build a VSIX via
   `npm run package:recorder` and install it, or install from the workspace via
   `code --install-extension provenance-recorder-*.vsix`).
2. The `test-workspace/` directory at the repo root (already present).
3. The workspace must contain a `.provenance-marker` file (or equivalent marker
   the recorder looks for) so the extension activates for it.

## Steps

### 1. Open test-workspace in VS Code

```bash
code test-workspace/
```

The recorder should activate and start logging. Confirm by checking that
`test-workspace/.provenance/` is created and `.slog`/`.slog.meta` files appear.

### 2. Do some realistic editing

Perform representative assignment work in `test-workspace/hw.py` (or whatever
file the recorder is tracking):

- Type a few lines of Python code manually (produces `doc.change` events).
- Paste a block of 10+ lines (produces a `paste` event — exercises `large_paste`
  heuristic).
- Save the file a few times (produces `doc.save` events).
- Open a terminal and run `python hw.py` (produces `terminal.command` events).

Aim for at least 50–100 events across 1–2 sessions (open + close VS Code once to
generate a second session if desired).

### 3. Seal the bundle

Run the VS Code command palette:

```
> Provenance: Prepare Submission Bundle
```

This calls `commands/seal.ts` in the recorder, producing a `.zip` in the
workspace directory (or `test-workspace/.provenance/` depending on the recorder
version — check the recorder's output panel).

### 4. Commit the fixture

Copy the ZIP to the fixtures directory and commit it:

```bash
cp <path-to-bundle.zip> packages/analyzer/test/fixtures/sample-bundle.zip
git add packages/analyzer/test/fixtures/sample-bundle.zip
git commit -m "test: update real-recorder fixture"
```

The fixture is a binary file. It is tracked by git to keep the integration test
self-contained — no external download needed in CI or on a new clone.

### 5. Run the integration test

```bash
npm run test --workspace=packages/analyzer
```

The test in `test/integration/load-and-validate.test.ts` skips automatically if
`test/fixtures/sample-bundle.zip` does not exist (so CI is never broken by a
missing fixture). Once the fixture is present, the test asserts:

- `loadBundle` succeeds.
- `runValidation` returns `overall: 'warn'` (check 8 is always skipped in v1).
- `runHeuristics` returns a flag array (content depends on what you edited).
- All session `firstEvent.kind === 'session.start'`.

## Troubleshooting

- **Recorder doesn't activate:** confirm the workspace has the marker file. See
  `packages/recorder/src/activation.ts` for the exact check.
- **`provenance.prepareSubmissionBundle` is missing:** you may need to rebuild
  and reinstall the recorder VSIX.
- **`loadBundle` fails on the fixture:** run the integration test in verbose mode
  (`npx vitest run --reporter=verbose test/integration`) to see the exact error.
  Common causes: format version mismatch (the fixture was built with a different
  log-core version), or missing `manifest.sig`.
