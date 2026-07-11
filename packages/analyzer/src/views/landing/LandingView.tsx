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
                Open dashboard <span aria-hidden="true">→</span>
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
