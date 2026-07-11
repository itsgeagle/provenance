/**
 * Same-origin SPA serving.
 *
 * On the apphost, the server serves the built analyzer SPA (static assets +
 * index.html) from the SAME origin as `/api/v1`, so the whole product is one
 * hostname behind nginx. `mountStatic()` wires two catch-all middlewares onto
 * the app, registered LAST (after `/healthz`, `/metrics`, and `/api/v1` are
 * already mounted in `createApp()`):
 *
 *   1. A static-asset middleware (`@hono/node-server`'s `serveStatic`) that
 *      serves real files under `publicDir` as-is (JS/CSS/images/etc, and
 *      `index.html` for `/`).
 *   2. An SPA-fallback middleware that serves `<publicDir>/index.html` for
 *      any GET that didn't resolve to a real file — this is what lets the
 *      analyzer's client-side router handle deep links like `/semesters/1`.
 *
 * Both middlewares explicitly skip any path under `/api`, `/healthz`, or
 * `/metrics` so they can never shadow those routes, even though they're
 * mounted as catch-alls after those routes are registered. In practice the
 * existing routes are terminal handlers that don't call `next()`, so they
 * already win — but `/api/v1`'s own catch-all middlewares (auth resolution,
 * membership cache init) DO call `next()` on an unmatched sub-path, which
 * would otherwise let an unmatched `/api/v1/*` request fall through to the
 * SPA fallback and get served `index.html` instead of a 404. The prefix
 * guard is what prevents that.
 *
 * `serveStatic`'s `root` option is passed straight through to `path.join()`
 * before hitting `fs`; both absolute and relative `publicDir` values work,
 * but a relative value resolves against `process.cwd()` at request time (not
 * against this file's location), so callers that care about cwd-independence
 * should pass an absolute path. `getConfig().PUBLIC_DIR` is resolved once at
 * config-parse time in `env.ts`.
 */

import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../logging.js';

const RESERVED_PREFIXES = ['/api', '/healthz', '/metrics'];

function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function mountStatic(app: Hono, opts: { publicDir: string }): void {
  const { publicDir } = opts;

  // If publicDir doesn't exist (e.g. dev/test without a built SPA — the
  // default PUBLIC_DIR is `./public`, which only a prod Docker build
  // populates), disable static serving entirely. Registering serveStatic
  // against a missing root makes it synchronously console.error on every
  // mount, which pollutes test output. Resolve the path first so a relative
  // `./public` is checked against process.cwd() the same way serveStatic
  // resolves it at request time.
  if (!existsSync(resolve(publicDir))) {
    getLogger().info({ publicDir }, 'SPA static serving disabled: PUBLIC_DIR not found');
    return;
  }

  const assetMiddleware = serveStatic({ root: publicDir });
  const indexMiddleware = serveStatic({ path: 'index.html', root: publicDir });

  // Real static assets (and `/` → index.html via serveStatic's own
  // directory-index behavior). Falls through to `next()` when no file
  // matches, so the SPA fallback below can take over.
  app.use('*', async (c, next) => {
    if (isReservedPath(c.req.path)) {
      return next();
    }
    return assetMiddleware(c, next);
  });

  // SPA fallback — any GET that isn't a real asset and isn't under a
  // reserved prefix gets index.html so client-side routing can take over.
  app.get('*', async (c, next) => {
    if (isReservedPath(c.req.path)) {
      return next();
    }
    return indexMiddleware(c, next);
  });
}
