# Provenance Analyzer

A web app for course staff to inspect Provenance Recorder logs: validates tamper-evident bundles, renders a searchable timeline of editing events, and flags suspicious patterns.

## What it does

The Analyzer loads a `.zip` bundle produced by the Provenance Recorder (or uploaded alongside a student submission). It validates the bundle's integrity, reconstructs the editing session, and surfaces high-value heuristic flags (large pastes, external edits, suspicious typing patterns, chain breaks) in a dashboard. Staff can drill into the raw timeline to review events in detail, and export findings as a markdown case file.

## Development

```sh
npm run dev --workspace=packages/analyzer
```

Opens a dev server at `http://localhost:5173`. Drop a `.zip` bundle in the load view to inspect it.

## Build

```sh
npm run build --workspace=packages/analyzer
```

Produces static assets in `packages/analyzer/dist/`. Type-checks, lints, and bundles in one step.

## Hosting

The analyzer is a static single-page app (SPA) that works at any URL prefix. Deploy `packages/analyzer/dist/` to any static host:

```sh
# Local preview
npx serve packages/analyzer/dist

# AWS S3
aws s3 sync packages/analyzer/dist/ s3://your-bucket/analyzer/

# Vercel / Netlify
vercel deploy packages/analyzer/dist
```

The build is configured with `base: './'`, so relative asset paths work regardless of where you mount it.

## Test fixture

To test against a real-recorder session, see `packages/analyzer/test/integration/regenerate-fixture.md`. The integration tests expect `packages/analyzer/test/fixtures/sample-bundle.zip` to exist and skip gracefully if it doesn't.

## Architecture

- **React 18 + TypeScript** — UI runtime with strict mode.
- **Vite** — bundler and dev server.
- **Tailwind + shadcn/ui** — styling and accessible component primitives.
- **react-router-dom** — routing (`/load`, `/overview`, `/timeline`; `/replay` planned for v2).
- `@provenance/log-core` — shared event types, validation, and hash chain. Runs unmodified in the browser.

## Learn more

- **Product spec** → [`docs/prd.md`](../../docs/prd.md) (§7.1–7.5 are the analyzer's scope)
- **Repo conventions** → [`CLAUDE.md`](../../CLAUDE.md)
- **Build plan** → [`docs/analyzer-implementation-plan.md`](../../docs/analyzer-implementation-plan.md)
