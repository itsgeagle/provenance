# Provenance Analyzer

A web app for course staff to inspect Provenance Recorder logs: validates tamper-evident bundles, renders a searchable timeline of editing events, and flags suspicious patterns.

## What it does

The Analyzer loads one or more `.zip` bundles produced by the Provenance Recorder. It validates each bundle's integrity, reconstructs the editing sessions, and surfaces heuristic flags (large pastes, external edits, suspicious typing patterns, chain breaks) in a dashboard. Staff can replay any session in a Monaco-based replay view (`/replay/:sessionId`) with transport controls, speed adjustment, and paste/external-change gutter decorations. Multiple bundles can be loaded simultaneously for cross-submission comparison (`/compare`), which runs cross-bundle heuristics to detect shared paste content and editing-pattern clones. Findings export to Markdown or PDF.

## Development

```sh
npm run dev --workspace=packages/analyzer
```

Opens the Vite dev server at `http://localhost:5173`.

This is the v3 SPA: Google sign-in and the cohort / per-submission views talk to the
API server, so run the backend too. See the
[root quickstart](../../README.md#run-the-analyzer-v3-server-api--worker) and
[`packages/server/README.md`](../../packages/server/README.md) for the server, and
`npm run seed --workspace=packages/server` to populate an example cohort to browse.

For a no-server flow, open `http://localhost:5173/local/load` and drop a `.zip` bundle —
the standalone offline mode (`/local`) runs entirely in-browser, no auth required.

## Build

```sh
npm run build --workspace=packages/analyzer
```

Produces static assets in `packages/analyzer/dist/`. Type-checks and bundles in one step (`tsc --noEmit && vite build`). Run `npm run lint --workspace=packages/analyzer` separately for lint.

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

Because the analyzer uses HTML5 history-API routing, your static host must rewrite all non-asset paths to `index.html` (single-page-app fallback). Direct navigation to `https://host/sub/overview` returns 404 on a vanilla static host without this rewrite. Examples: GitHub Pages — add a `404.html` redirect; Netlify — add `/* /index.html 200` to `_redirects`; Vercel — automatic; nginx — `try_files $uri /index.html;`.

## Test fixture

To test against a real-recorder session, see `packages/analyzer/test/integration/regenerate-fixture.md`. The integration tests expect `packages/analyzer/test/fixtures/sample-bundle.zip` to exist and skip gracefully if it doesn't.

## Architecture

- **React 18 + TypeScript** — UI runtime with strict mode.
- **Vite** — bundler and dev server.
- **Tailwind + shadcn/ui** — styling and accessible component primitives.
- **react-router-dom** — routing (`/load`, `/overview`, `/timeline`, `/replay/:sessionId`, `/compare`).
- `@provenance/log-core` — shared event types, validation, and hash chain. Runs unmodified in the browser.

## Learn more

- **Product spec** → [`docs/analyzer-v3-prd.md`](../../docs/analyzer-v3-prd.md) (the analyzer + server v3 spec)
- **Design doc** → [`docs/analyzer-v3-design.md`](../../docs/analyzer-v3-design.md)
- **Repo conventions** → [`CLAUDE.md`](../../CLAUDE.md)
- **Build plan** → [`docs/analyzer-v3-implementation-plan.md`](../../docs/analyzer-v3-implementation-plan.md)
