/**
 * GET /api/v1/docs — Redoc API documentation page (public, no auth).
 *
 * Renders the OpenAPI spec via Redoc loaded from CDN.
 * No auth required so external users can discover the API without credentials.
 */

import { Hono } from 'hono';

const REDOC_HTML = `<!doctype html>
<html>
<head>
  <title>Provenance API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <redoc spec-url="/api/v1/openapi.json"></redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`;

export function createDocsRouter(): Hono {
  const router = new Hono();

  router.get('/docs', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(REDOC_HTML);
  });

  return router;
}
