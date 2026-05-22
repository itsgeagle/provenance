/**
 * OpenAPI path declarations for §8.13 Audit + §8.14 OpenAPI.
 */

export const auditOpenApiPaths = {
  // =========================================================================
  // Audit §8.13
  // =========================================================================
  '/audit': {
    get: {
      tags: ['Audit'],
      summary: 'Query audit log (semester admin or superadmin)',
      description: [
        'Semester admins see rows scoped to their administered semesters.',
        'Superadmins see all rows.',
        'Cursor encodes (created_at, id) DESC.',
      ].join(' '),
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semester_id',
          in: 'query',
          schema: { $ref: '#/components/schemas/UUID' },
          description: 'Filter to a specific semester. For semester admins: must be a semester they admin.',
        },
        {
          name: 'actor_user_id',
          in: 'query',
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'action',
          in: 'query',
          schema: { type: 'string' },
          description: 'Exact action string from PRD §13 catalog.',
        },
        {
          name: 'since',
          in: 'query',
          schema: { $ref: '#/components/schemas/ISODate' },
        },
        {
          name: 'until',
          in: 'query',
          schema: { $ref: '#/components/schemas/ISODate' },
        },
        {
          name: 'cursor',
          in: 'query',
          schema: { type: 'string' },
          description: 'Base64-encoded JSON cursor from previous response.',
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
        },
      ],
      responses: {
        '200': {
          description: 'Audit log rows',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items', 'next_cursor'],
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AuditLogRow' },
                  },
                  next_cursor: {
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                    description: 'Pass as ?cursor= for the next page. null when no more rows.',
                  },
                },
              },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not an admin anywhere)' },
      },
    },
  },

  // =========================================================================
  // OpenAPI §8.14
  // =========================================================================
  '/openapi.json': {
    get: {
      tags: ['Meta'],
      summary: 'OpenAPI 3.1 spec (public)',
      description: 'Returns the full OpenAPI 3.1 JSON document. No auth required.',
      responses: {
        '200': {
          description: 'OpenAPI document',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  },
  '/docs': {
    get: {
      tags: ['Meta'],
      summary: 'Redoc API documentation page (public)',
      description: 'Interactive HTML documentation rendered from the OpenAPI spec.',
      responses: {
        '200': {
          description: 'HTML documentation page',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
      },
    },
  },
} as const;
