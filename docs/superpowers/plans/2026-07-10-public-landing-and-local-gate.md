# Public Landing Page + `/local` Staff-Auth Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, WCAG-2.1-AA landing page at `/` and gate the `/local` analyzer subtree behind staff authorization (membership-or-superadmin), in `packages/analyzer`.

**Architecture:** A new public `LandingView` replaces the `/` → `/home` redirect. A shared `GoogleSignInButton` is extracted from `LoginView` and reused by both. A new `RequireStaff` route guard (layered under the existing `RequireAuth`) wraps `/local`, requiring `memberships.length > 0 || is_superadmin`. The dashboard gains a "Local analysis" link for staff.

**Tech Stack:** React 18, react-router-dom v6, TanStack Query v5, Tailwind (shadcn tokens), Vitest + Testing Library + MSW.

## Global Constraints

- **Working directory:** all paths are under `packages/analyzer/`. Run all commands from repo root with `--workspace=packages/analyzer`, e.g. `npm run test --workspace=packages/analyzer -- <file>`.
- **ESM relative imports MUST use the `.js` extension** (e.g. `import { X } from './X.js'`). This repo compiles `.tsx` but imports resolve with `.js`. Copy this convention exactly.
- **TypeScript strict mode.** No `any`. Props typed with explicit interfaces.
- **Tests are colocated** (`Foo.tsx` ↔ `Foo.test.tsx`) and deterministic. Use MSW handlers from `src/test/msw-handlers.js`; never hit a network.
- **No new dependencies.**
- **WCAG 2.1 AA on the landing page:** exactly one `<h1>`; section headings are `<h2>` in order; a `<main>` landmark wraps content; body text uses `text-gray-700`/`text-gray-600`/`text-gray-900` (never `text-gray-400`); interactive elements keep a visible `focus-visible`/`focus:ring-2` ring; decorative SVG is `aria-hidden="true"`.
- **Commits:** conventional-commit prefix, `git commit --no-gpg-sign`, **no `Co-Authored-By` trailer**. Work happens on branch `feat/public-landing-and-local-gate` (already created).
- **`getBaseUrl()`** returns `/api/v1` by default, so a sign-in form action is `/api/v1/auth/google/start?return_to=<encoded>`.

---

### Task 1: Extract `GoogleSignInButton` and reuse it in `LoginView`

Pull the Google sign-in form + button + icon out of `LoginView` into a reusable component, so `LandingView` (Task 3) can render the same button. Pure refactor — behavior unchanged.

**Files:**

- Create: `packages/analyzer/src/components/GoogleSignInButton.tsx`
- Create: `packages/analyzer/src/components/GoogleSignInButton.test.tsx`
- Modify: `packages/analyzer/src/views/login/LoginView.tsx`

**Interfaces:**

- Produces: `GoogleSignInButton({ returnTo }: { returnTo?: string })` — renders a `<form method="POST" action="{base}/auth/google/start?return_to={encoded}">` containing a submit `<button>` labelled "Sign in with Google". `returnTo` defaults to `/home`.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/components/GoogleSignInButton.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GoogleSignInButton } from './GoogleSignInButton.js';

describe('GoogleSignInButton', () => {
  it('renders a submit button labelled "Sign in with Google"', () => {
    render(<GoogleSignInButton />);
    const button = screen.getByRole('button', { name: /sign in with google/i });
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('posts to /api/v1/auth/google/start with return_to=/home by default', () => {
    render(<GoogleSignInButton />);
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form).toHaveAttribute('method', 'POST');
    expect(form?.getAttribute('action')).toContain('/api/v1/auth/google/start');
    expect(form?.getAttribute('action')).toContain('return_to=');
    expect(form?.getAttribute('action')).toContain('%2Fhome');
  });

  it('encodes a custom returnTo into the form action', () => {
    render(<GoogleSignInButton returnTo="/s/cs61a/sp25" />);
    const form = screen.getByRole('button', { name: /sign in with google/i }).closest('form');
    expect(form?.getAttribute('action')).toContain('%2Fs%2Fcs61a%2Fsp25');
  });

  it('marks the Google icon as decorative (aria-hidden)', () => {
    const { container } = render(<GoogleSignInButton />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- src/components/GoogleSignInButton.test.tsx`
Expected: FAIL — cannot resolve `./GoogleSignInButton.js`.

- [ ] **Step 3: Create the component**

Create `packages/analyzer/src/components/GoogleSignInButton.tsx`:

```tsx
/**
 * GoogleSignInButton — the "Sign in with Google" form + button.
 *
 * Shared by LoginView and LandingView. Submits a form POST to
 * /auth/google/start; the server returns a 302 to Google's authorize URL,
 * which the browser follows. `returnTo` is where the OAuth callback lands the
 * user after a successful sign-in (default /home).
 */

import { getBaseUrl } from '../api/client.js';

interface GoogleSignInButtonProps {
  /** Path to return to after sign-in completes. Defaults to /home. */
  returnTo?: string;
}

export function GoogleSignInButton({ returnTo = '/home' }: GoogleSignInButtonProps) {
  return (
    <form
      method="POST"
      action={`${getBaseUrl()}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`}
    >
      <button
        type="submit"
        className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        <GoogleIcon />
        Sign in with Google
      </button>
    </form>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Refactor `LoginView` to use it**

In `packages/analyzer/src/views/login/LoginView.tsx`:

1. Add the import near the top (with the other imports):

```tsx
import { GoogleSignInButton } from '../../components/GoogleSignInButton.js';
```

2. Replace the entire `<form method="POST" …> … </form>` block (the form containing the submit button and `<GoogleIcon />`) with:

```tsx
<GoogleSignInButton returnTo={returnTo} />
```

3. Delete the now-unused local `GoogleIcon` function at the bottom of the file.

(Leave everything else — the error-message rendering, the `next` → `returnTo` logic, the heading — untouched. Note `getBaseUrl` may now be an unused import in `LoginView`; remove it if lint flags it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/components/GoogleSignInButton.test.tsx src/views/login/LoginView.test.tsx`
Expected: PASS — both files green (LoginView's existing form-action assertions still hold because the markup is identical, just relocated).

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/src/components/GoogleSignInButton.tsx packages/analyzer/src/components/GoogleSignInButton.test.tsx packages/analyzer/src/views/login/LoginView.tsx
git commit --no-gpg-sign -m "refactor(analyzer): extract shared GoogleSignInButton from LoginView"
```

---

### Task 2: `RequireStaff` authorization guard

A route guard that renders children only for course staff — a principal with at least one membership, or a superadmin. Runs _below_ `RequireAuth` (which has already proven a session). This is the boundary that keeps signed-in students out of `/local`.

**Files:**

- Create: `packages/analyzer/src/auth/RequireStaff.tsx`
- Create: `packages/analyzer/src/auth/RequireStaff.test.tsx`

**Interfaces:**

- Consumes: `useMe()` from `../api/queries.js` → `{ data: { user: { is_superadmin: boolean }, memberships: unknown[] } | undefined, isLoading }`.
- Produces: `RequireStaff({ children }: { children: ReactNode })` — renders `children` when `data.memberships.length > 0 || data.user.is_superadmin`; otherwise `<Navigate to="/home" replace />`; shows a "Loading…" placeholder while `isLoading`.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/auth/RequireStaff.test.tsx`:

```tsx
/**
 * RequireStaff tests.
 *
 * - Member (default /me) → children rendered.
 * - Superadmin with no memberships → children rendered.
 * - Authenticated non-staff (no memberships, not superadmin) → redirect to /home.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http } from 'msw';
import { mswServer } from '../test-setup.js';
import { meNoSemestersHandler, defaultMeResponse, defaultUser } from '../test/msw-handlers.js';
import { RequireStaff } from './RequireStaff.js';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderGuarded() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={['/local/load']}>
        <Routes>
          <Route path="/home" element={<div data-testid="home-page">Home</div>} />
          <Route
            path="/local/load"
            element={
              <RequireStaff>
                <div data-testid="staff-content">Staff Content</div>
              </RequireStaff>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireStaff', () => {
  it('renders children for a user with a membership', async () => {
    // Default handler returns a user with one membership.
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('staff-content')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });

  it('renders children for a superadmin with no memberships', async () => {
    mswServer.use(
      http.get('/api/v1/me', () =>
        Response.json({
          ...defaultMeResponse,
          user: { ...defaultUser, is_superadmin: true },
          memberships: [],
        }),
      ),
    );
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('staff-content')).toBeInTheDocument();
    });
  });

  it('redirects a non-staff user (no memberships, not superadmin) to /home', async () => {
    mswServer.use(meNoSemestersHandler());
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('staff-content')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- src/auth/RequireStaff.test.tsx`
Expected: FAIL — cannot resolve `./RequireStaff.js`.

- [ ] **Step 3: Create the guard**

Create `packages/analyzer/src/auth/RequireStaff.tsx`:

```tsx
/**
 * RequireStaff — authorization guard for staff-only routes (e.g. /local).
 *
 * Layered BELOW RequireAuth (which has already verified a session). This adds
 * an authorization check: the principal must be course staff — i.e. have at
 * least one semester membership, or be a superadmin.
 *
 * Why this exists: RequireAuth only proves a valid @berkeley.edu session, which
 * every student has. Membership is the invite-only boundary that distinguishes
 * staff from students. Non-staff are redirected to /home (where they see the
 * "Ask an admin to invite you" empty state), with no flash of staff chrome.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../api/queries.js';

export function RequireStaff({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-gray-500">Loading…</span>
      </div>
    );
  }

  if (data === undefined || (data.memberships.length === 0 && !data.user.is_superadmin)) {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- src/auth/RequireStaff.test.tsx`
Expected: PASS — all three cases green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/auth/RequireStaff.tsx packages/analyzer/src/auth/RequireStaff.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): add RequireStaff authz guard (membership-or-superadmin)"
```

---

### Task 3: `LandingView` — public explainer + auth-aware CTA

The public front door: a `<main>` with a hero, three explainer sections, and a CTA that is "Sign in with Google" when signed-out and "Open dashboard →" when signed-in. WCAG-2.1-AA.

**Files:**

- Create: `packages/analyzer/src/views/landing/LandingView.tsx`
- Create: `packages/analyzer/src/views/landing/LandingView.test.tsx`

**Interfaces:**

- Consumes: `GoogleSignInButton` (Task 1); `useMe()` from `../../api/queries.js`.
- Produces: `LandingView()` — default-exportless named component. Renders exactly one `<h1>` ("Provenance") and three `<h2>`s ("What it does", "Protects honest students", "Integrity & privacy"). When `useMe()` returns data, renders a `Link` to `/home` labelled "Open dashboard →"; otherwise renders `<GoogleSignInButton returnTo="/home" />`.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/views/landing/LandingView.test.tsx`:

```tsx
/**
 * LandingView tests.
 *
 * - Anonymous: renders the sign-in button, the h1, and the three sections.
 * - Authenticated: renders an "Open dashboard" link instead of the button.
 * - Accessibility smoke: exactly one h1, a main landmark.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mswServer } from '../../test-setup.js';
import { meUnauthorizedHandler } from '../../test/msw-handlers.js';
import { LandingView } from './LandingView.js';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderLanding() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <LandingView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LandingView', () => {
  it('renders exactly one h1 titled "Provenance" inside a main landmark', () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/provenance/i);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the three explainer section headings', () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    expect(screen.getByRole('heading', { level: 2, name: /what it does/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /protects honest students/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /integrity/i })).toBeInTheDocument();
  });

  it('shows the sign-in button when the visitor is not authenticated', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderLanding();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /open dashboard/i })).not.toBeInTheDocument();
  });

  it('shows an "Open dashboard" link to /home when the visitor is authenticated', async () => {
    // Default handler returns an authenticated user.
    renderLanding();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /open dashboard/i });
      expect(link).toHaveAttribute('href', '/home');
    });
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- src/views/landing/LandingView.test.tsx`
Expected: FAIL — cannot resolve `./LandingView.js`.

- [ ] **Step 3: Create the component**

Create `packages/analyzer/src/views/landing/LandingView.tsx`:

```tsx
/**
 * LandingView — public front door at `/` (no auth required).
 *
 * A short explainer of what Provenance is, shown before the sign-in page.
 * The CTA is auth-aware: signed-out visitors get "Sign in with Google";
 * signed-in staff get "Open dashboard →". We never block the page render on
 * the auth check — content shows immediately and the CTA resolves when
 * useMe() settles (undefined while loading or when unauthenticated → sign-in).
 *
 * WCAG 2.1 AA: single h1, h2 section headings, a <main> landmark, contrast-safe
 * gray text (700/600/900), visible focus rings, decorative icon aria-hidden.
 */

import { Link } from 'react-router-dom';
import { useMe } from '../../api/queries.js';
import { GoogleSignInButton } from '../../components/GoogleSignInButton.js';

export function LandingView() {
  const { data } = useMe();
  const isAuthed = data !== undefined;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-gray-900">Provenance</h1>
          <p className="mt-2 text-lg text-gray-700">
            Process-based academic integrity for lower-division CS.
          </p>
          <p className="mx-auto mt-4 max-w-xl text-sm text-gray-600">
            Provenance records how an assignment was built — not just the final file — so course
            staff have evidence about a student&rsquo;s process when a submission looks off.
          </p>
          <div className="mx-auto mt-8 max-w-sm">
            {isAuthed ? (
              <Link
                to="/home"
                className="inline-flex w-full items-center justify-center rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                Open dashboard →
              </Link>
            ) : (
              <GoogleSignInButton returnTo="/home" />
            )}
          </div>
        </header>

        <section className="mt-16">
          <h2 className="text-xl font-semibold text-gray-900">What it does</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm text-gray-700">
            <li>
              Records the process of building an assignment — edits, pastes, saves, and external
              changes — in a tamper-evident log.
            </li>
            <li>
              Flags patterns worth a closer look, like a finished function appearing in a single
              large paste.
            </li>
            <li>Gives staff concrete, process-based evidence instead of guesswork.</li>
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-gray-900">Protects honest students</h2>
          <p className="mt-4 text-sm text-gray-700">
            The goal cuts both ways: surfacing AI-related dishonesty while protecting honest
            students from false accusations. Process evidence is how an honest student clears their
            name.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-gray-900">Integrity &amp; privacy</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm text-gray-700">
            <li>
              The recorder runs entirely offline — it makes no network calls during a session.
            </li>
            <li>
              The protocol and extension source are public by design; there is nothing hidden in how
              it works.
            </li>
            <li>
              Only the provenance log is stored. Student source files are used to verify the log at
              submission, then discarded — not kept.
            </li>
            <li>Log bundles are retained for one semester, then purged.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- src/views/landing/LandingView.test.tsx`
Expected: PASS — all four cases green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/landing/LandingView.tsx packages/analyzer/src/views/landing/LandingView.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): add public LandingView with auth-aware CTA"
```

---

### Task 4: Wire routes — public `/`, staff-gated `/local` — and fix stale LocalShell comments

Mount `LandingView` at `/` (replacing the redirect), wrap `/local` in `RequireAuth` + `RequireStaff`, update the now-inaccurate `App.test.tsx` root-redirect test, and correct the LocalShell comments that claim `/local` is unauthenticated.

**Files:**

- Modify: `packages/analyzer/src/App.tsx`
- Modify: `packages/analyzer/src/App.test.tsx`
- Modify: `packages/analyzer/src/views/local/LocalShell.tsx` (comments only)

**Interfaces:**

- Consumes: `LandingView` (Task 3), `RequireStaff` (Task 2), existing `RequireAuth`, `LocalShell`.

- [ ] **Step 1: Update the routing tests first (they will fail)**

In `packages/analyzer/src/App.test.tsx`:

1. The existing top-of-file imports already include `meUnauthorizedHandler`. Leave them.

2. Replace the first test — `it('redirects / to /home (unauthenticated → /login)', …)` — with these three tests:

```tsx
it('renders the public landing page at / for anonymous visitors', async () => {
  mswServer.use(meUnauthorizedHandler());
  renderApp('/');
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1, name: /provenance/i })).toBeInTheDocument();
  });
  // Anonymous → sign-in button, NOT redirected away to a protected page.
  expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
});

it('redirects anonymous visitors from /local/load to the login page', async () => {
  mswServer.use(meUnauthorizedHandler());
  renderApp('/local/load');
  // RequireAuth bounces anon → /login, which shows the sign-in button and NOT the drop zone.
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
  });
  expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
});

it('renders /local/load for an authenticated staff member', async () => {
  // Default /me handler returns a user WITH a membership → RequireStaff passes.
  renderApp('/local/load');
  await waitFor(() => {
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  });
});
```

(The remaining local-route tests — `/load` redirect, `RequireLocalBundle` redirects, bundle-load navigation — are unchanged: they render under the default `/me` handler, which is a staff member, so they pass through the new gate.)

- [ ] **Step 2: Run the routing test to verify the new anon-`/` case fails**

Run: `npm run test --workspace=packages/analyzer -- src/App.test.tsx`
Expected: FAIL — `/` still redirects to `/home` → `/login`, so no `<h1>Provenance</h1>` renders on the landing page (the landing heading assertion fails). The `/local` anon test may also fail because `/local` is not yet gated (drop-zone shows for anon).

- [ ] **Step 3: Wire the routes in `App.tsx`**

In `packages/analyzer/src/App.tsx`:

1. Add imports alongside the existing static imports near the top:

```tsx
import { LandingView } from './views/landing/LandingView.js';
import { RequireStaff } from './auth/RequireStaff.js';
```

2. Replace the root redirect route:

```tsx
<Route path="/" element={<Navigate to="/home" replace />} />
```

with:

```tsx
<Route path="/" element={<LandingView />} />
```

3. Gate the `/local` subtree. Change the opening of the `/local` route from:

```tsx
        <Route path="/local" element={<LocalShell />}>
```

to:

```tsx
        <Route
          path="/local"
          element={
            <RequireAuth>
              <RequireStaff>
                <LocalShell />
              </RequireStaff>
            </RequireAuth>
          }
        >
```

(Leave the nested child routes — `load`, `overview`, `timeline`, `compare`, `replay/:sessionId`, and the index redirect — exactly as they are. Leave the `*` catch-all → `/home` untouched.)

4. Update the route-structure doc comment at the top of the file: change the `/` line to `→ public LandingView (no auth)` and note that `/local` is now wrapped in `RequireAuth + RequireStaff`.

- [ ] **Step 4: Fix the stale comments in `LocalShell.tsx`**

In `packages/analyzer/src/views/local/LocalShell.tsx`, update the two comments that now misstate the auth model:

- In the file/section header comment, replace the sentence that says local mode requires _no authentication_ (citing PRD §15) with: `/local is now staff-gated — see App.tsx, where the subtree is wrapped in RequireAuth + RequireStaff (PRD §15 amended 2026-07-10).`
- In the `LocalShell` function's doc comment, replace `RequireAuth is NOT used here — see App.tsx where /local routes are mounted outside the RequireAuth tree.` with `Auth is enforced one level up in App.tsx (RequireAuth + RequireStaff wrap this subtree).`

(Do not change the `LocalModeBanner` copy — "no data leaves your browser" is still accurate.)

- [ ] **Step 5: Run the full analyzer suite**

Run: `npm run test --workspace=packages/analyzer -- src/App.test.tsx src/views/local/LocalShell.test.tsx`
Expected: PASS — new landing/anon-`/local`/staff-`/local` cases green; existing local-route and LocalShell tests still green.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/src/App.tsx packages/analyzer/src/App.test.tsx packages/analyzer/src/views/local/LocalShell.tsx
git commit --no-gpg-sign -m "feat(analyzer): serve public landing at /, gate /local behind RequireAuth+RequireStaff"
```

---

### Task 5: Dashboard "Local analysis" link (staff only)

Give signed-in staff an entry point to `/local` from the dashboard header. It appears only on the populated (has-memberships) view — never in the empty state, since a no-membership user is exactly who we keep out of `/local`.

**Files:**

- Modify: `packages/analyzer/src/views/home/HomeView.tsx`
- Modify: `packages/analyzer/src/views/home/HomeView.test.tsx`

**Interfaces:**

- Consumes: `Link` from `react-router-dom` (already imported in `HomeView`).
- Produces: a `Link` to `/local/load` with `data-testid="local-analysis-link"`, rendered in the populated dashboard header only.

- [ ] **Step 1: Add the failing tests**

Append two tests inside the `describe('HomeView', …)` block in `packages/analyzer/src/views/home/HomeView.test.tsx` (the file already imports `meNoSemestersHandler`):

```tsx
it('shows a "Local analysis" link to /local/load on the populated dashboard', async () => {
  renderHomeView();
  await waitFor(() => {
    expect(screen.getByTestId('local-analysis-link')).toBeInTheDocument();
  });
  expect(screen.getByTestId('local-analysis-link')).toHaveAttribute('href', '/local/load');
});

it('does NOT show the "Local analysis" link in the empty state', async () => {
  mswServer.use(meNoSemestersHandler());
  renderHomeView();
  await waitFor(() => {
    expect(screen.getByTestId('no-semesters-message')).toBeInTheDocument();
  });
  expect(screen.queryByTestId('local-analysis-link')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/home/HomeView.test.tsx`
Expected: FAIL — no element with `data-testid="local-analysis-link"`.

- [ ] **Step 3: Add the link to the populated header**

In `packages/analyzer/src/views/home/HomeView.tsx`, replace the populated-view header line:

```tsx
<h1 className="mb-6 text-xl font-semibold text-gray-900">Your Semesters</h1>
```

with a header row that keeps the `h1` and adds the link:

```tsx
<div className="mb-6 flex items-center justify-between">
  <h1 className="text-xl font-semibold text-gray-900">Your Semesters</h1>
  <Link
    to="/local/load"
    data-testid="local-analysis-link"
    className="text-sm font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
  >
    Local analysis →
  </Link>
</div>
```

(Do not touch the loading, error, or empty-state branches — they return early and must NOT render the link.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/home/HomeView.test.tsx`
Expected: PASS — link present on populated view, absent in empty state; existing HomeView tests still green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/home/HomeView.tsx packages/analyzer/src/views/home/HomeView.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): add staff-only Local analysis link to dashboard"
```

---

### Task 6: Full-suite verification

Confirm nothing else in the analyzer regressed (routing, auth, local-mode wiring all touch shared surfaces).

**Files:** none (verification only).

- [ ] **Step 1: Run the whole analyzer test suite**

Run: `npm run test --workspace=packages/analyzer`
Expected: PASS — entire suite green.

- [ ] **Step 2: Typecheck + lint the workspace**

Run: `npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: no errors.

- [ ] **Step 3: Build the analyzer**

Run: `npm run build --workspace=packages/analyzer`
Expected: build succeeds (tsc + vite).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the dev server (`npm run dev --workspace=packages/analyzer`) and verify: `/` shows the landing page with a working "Sign in with Google" button; visiting `/local/load` while signed-out bounces to the login page; the dashboard shows the "Local analysis →" link once signed in as staff.

---

## Self-Review

**Spec coverage:**

- Public landing page (Explainer + door), 3 content blocks, no footer → Task 3. ✓
- Auth-aware CTA (sign-in / open dashboard) → Task 3. ✓
- Shared `GoogleSignInButton` → Task 1. ✓
- `/local` gated on `RequireAuth` + `RequireStaff` (membership-or-superadmin) → Tasks 2 + 4. ✓
- Routing: public `/`, gated `/local`, catch-all untouched → Task 4. ✓
- LocalShell stale-comment cleanup → Task 4. ✓
- Dashboard `/local` link, populated-only (no empty-state link) → Task 5. ✓
- WCAG 2.1 AA on landing (single h1, h2s, main, contrast, focus, aria-hidden) → Global Constraints + Task 3 (+ tests). ✓
- Tests: RequireStaff, LandingView, routing, HomeView link, LoginView still-passing → Tasks 1–5. ✓
- §15 PRD amendment → already committed in the spec phase (`docs/analyzer-v3-prd.md`); not re-done here. ✓
- Non-goal: full app WCAG audit is out of scope (separate task). ✓

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". All code shown in full. ✓

**Type consistency:** `GoogleSignInButton({ returnTo })` used identically in Tasks 1 and 3. `RequireStaff({ children })` defined in Task 2, consumed in Task 4. `useMe()` shape (`data.memberships`, `data.user.is_superadmin`) matches `MeResponseSchema` fixtures in `msw-handlers.ts`. `data-testid="local-analysis-link"` consistent between Task 5 test and impl. ✓

**Note on server-side enforcement:** `/local` analysis runs entirely in-browser (no API calls for the analysis itself), so `RequireStaff` being client-only is acceptable — there is no backend endpoint that `/local` reaches which would need a matching server guard. All server-backed routes remain protected by their existing server-side session/authorization checks, unchanged by this plan.
