/**
 * GET /api/v1/openapi.json — serves the OpenAPI 3.1 spec (public, no auth).
 *
 * Cache-Control: max-age=3600 — the spec is a build-time artifact;
 * clients can cache it for an hour without staleness concerns.
 */

import { Hono } from 'hono';
import { openApiSpec } from '../../../openapi/spec/index.js';

const SPEC_JSON = JSON.stringify(openApiSpec);

export function createOpenApiRouter(): Hono {
  const router = new Hono();

  router.get('/openapi.json', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Type', 'application/json');
    return c.body(SPEC_JSON);
  });

  return router;
}
