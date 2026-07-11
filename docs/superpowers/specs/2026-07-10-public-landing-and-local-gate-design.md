# Public landing page + `/local` auth gate — design

**Date:** 2026-07-10
**Workspace:** `packages/analyzer`
**Status:** approved (pending spec review)

## Problem

`provenance.eecs.berkeley.edu` is now deployed and publicly reachable. Two gaps:

1. **No public front door.** `/` redirects to `/home`, which requires auth and
   bounces anonymous visitors straight to the `/login` "Sign in with Google"
   card. The first thing the public sees is a bare login prompt.
2. **`/local` is open to the world.** The `/local/*` "drop a `.zip`" subtree is
   deliberately unauthenticated. On a public deployment that lets anyone —
   including students — run arbitrary bundles through the analyzer.

## Goals

- A simple, public-facing landing page ("nicer front door") shown before the
  sign-in page, WCAG 2.1 AA compliant.
- Gate `/local` behind sign-in so only authenticated staff can use the analyzer.
- Keep signed-in staff able to reach local mode from the dashboard.

## Non-goals

- A full WCAG audit of the rest of the analyzer app (separate follow-up task).
- An accessibility-statement page/link (declined for now).
- Any change to the login mechanism, OAuth flow, or `RequireAuth` semantics.

## PRD impact (surface, not bury)

Analyzer PRD **§15** states: *"the standalone local mode MUST be accessible
without login so that instructors can run the analyzer offline without a
deployed backend."* Gating `/local` behind `RequireAuth` **deviates from §15**.

This is an approved product-behavior change (the tool is now a required,
department-hosted deployment; the offline-no-backend story is superseded).
**Action:** amend analyzer-v3-prd §15 to reflect that local mode now requires
authentication. Called out here so review catches it.

## Design

### 1. Routing (`src/App.tsx`)

- Add public route: `<Route path="/" element={<LandingView />} />`. Replaces the
  current `/` → `/home` redirect. No `RequireAuth`.
- Wrap the `/local` subtree in `RequireAuth`:
  `element={<RequireAuth><LocalShell /></RequireAuth>}`. Anonymous visitors are
  redirected to `/login?next=/local/…` by the existing guard.
- `/login`, `/home`, `/s/*`, `/admin/*`, `/me/tokens`, and the `*` catch-all are
  unchanged. (`*` continues to point at `/home`; an authed user landing there
  sees the dashboard, an anon user bounces to login — existing behavior.)

### 2. `LandingView` (`src/views/landing/LandingView.tsx`)

A `<main>` landmark with a centered, `max-w-*` column. Sections:

- **Hero** — `h1` "Provenance", a one-line tagline, a one-sentence description,
  and the primary CTA (see §3).
- **"What it does"** (`h2`) — 3 short points:
  - records the *process* of building an assignment, not just the final file;
  - flags patterns worth a closer look (e.g. a finished function in one paste);
  - gives staff process-based evidence instead of guesswork.
- **"Protects honest students"** (`h2`) — short paragraph: the two-sided goal of
  curbing AI-related dishonesty *and* clearing honest students from false flags.
- **"Integrity & privacy"** (`h2`) — brief bullets:
  - the recorder runs offline — no network calls during a session;
  - the protocol and extension source are public by design;
  - only provenance logs are stored; student source is stripped after ingest;
  - log bundles are retained for one semester, then purged.

No attribution footer.

### 3. Auth-aware CTA

`LandingView` calls `useMe()`:

- signed-out, loading, or any error → render `GoogleSignInButton` ("Sign in with
  Google");
- `useMe()` returns a user → render an "Open dashboard →" `Link` to `/home`.

Content renders immediately regardless of auth state — no blocking spinner on a
public page, and no auto-redirect (the landing page stays reachable/shareable
even when signed in).

### 4. Shared sign-in button (`src/components/GoogleSignInButton.tsx`)

Extract the sign-in button — the `<form method="POST" action=".../auth/google/
start?return_to=…">`, the submit button, and the `GoogleIcon` — from
`LoginView` into a reusable component.

- Props: `{ returnTo?: string }` (default `/home`).
- Consumed by both `LoginView` and `LandingView`.
- `LoginView` keeps its own error-message rendering and `next`→`return_to`
  forwarding; only the button markup moves.

### 5. `/local` gate cleanup (`src/views/local/LocalShell.tsx`)

The route wrapping (§1) does the gating. In `LocalShell`, update the now-
inaccurate header comment (which cites §15 "no authentication required") and the
local-mode banner copy so they no longer claim local mode is unauthenticated.

### 6. Dashboard `/local` entry (`src/views/home/HomeView.tsx`)

Add a "Local analysis" link to `/local/load` in the dashboard header (next to the
"Your Semesters" `h1`), so signed-in staff retain an entry point to local mode.
Also surface it in the empty-state branch (a user with no memberships can still
use local mode). Styled as an in-app link matching existing link treatment.

### 7. Accessibility (WCAG 2.1 AA — built in)

The landing page ships compliant from the start:

- exactly one `h1`; section headings are `h2` in document order;
- `<main>` landmark wraps the content;
- all body text meets ≥ 4.5:1 contrast (no `text-gray-400` for meaningful text;
  use `gray-600`/`gray-700` on white); large text ≥ 3:1;
- interactive elements have a visible `focus-visible` ring;
- decorative icons (Google glyph) are `aria-hidden`;
- layout reflows to 320px width with no horizontal scroll (relative units,
  flex/`max-w-full`);
- correct semantics: "Open dashboard" is a `Link`, "Sign in" is a form submit
  `button`.

### 8. Components & interfaces

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `LandingView` | Public explainer + auth-aware CTA | `useMe`, `GoogleSignInButton`, `react-router` `Link` |
| `GoogleSignInButton` | Sign-in form + button + icon | `getBaseUrl()` |
| `LoginView` (edited) | Sign-in card; error + `next` handling | `GoogleSignInButton` |
| `LocalShell` (edited) | `/local` layout; comment/banner copy | — |
| `HomeView` (edited) | Dashboard + local-analysis link | `react-router` `Link` |
| `App` (edited) | Routes: public `/`, gated `/local` | `RequireAuth`, `LandingView` |

## Testing

- **`LandingView.test.tsx`** (new):
  - renders one `h1` and the three `h2` section headings;
  - signed-out: renders the sign-in form with action
    `…/auth/google/start?return_to=%2Fhome`;
  - signed-in (msw `/me` returns a user): renders an "Open dashboard" link to
    `/home` and *not* the sign-in button;
  - a11y smoke: single `h1`, a `main` landmark present.
- **`GoogleSignInButton.test.tsx`** (new, or folded into `LoginView.test.tsx`):
  form action and `returnTo` encoding.
- **Routing tests** (`App.test.tsx` / local route tests): `/` renders
  `LandingView` (no redirect); `/local/load` while anonymous redirects to
  `/login?next=%2Flocal%2Fload`; authenticated `/local/load` still renders.
- **Existing `/local` tests**: update any that assumed no auth (provide the msw
  `/me` handler or assert the redirect).
- **`LoginView.test.tsx`**: still passes after the button extraction.

## Files

- New: `src/views/landing/LandingView.tsx` (+ `.test.tsx`)
- New: `src/components/GoogleSignInButton.tsx` (+ test or folded)
- Edit: `src/App.tsx` (routes)
- Edit: `src/views/login/LoginView.tsx` (use shared button)
- Edit: `src/views/local/LocalShell.tsx` (comment + banner copy)
- Edit: `src/views/home/HomeView.tsx` (local-analysis link)
- Edit: `src/App.test.tsx` and affected `/local` tests

## Risks / notes

- **§15 deviation** — documented above; requires a PRD amendment.
- Offline/no-backend builds of `/local` will now fail the auth check (there is no
  `/me` to call). This is the accepted consequence of "gate everywhere."
