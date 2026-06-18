/**
 * OpenAPI path declarations for V45 superadmin-only routes (§8.15).
 *
 * All routes require BearerAuth or SessionCookie + is_superadmin === true.
 */

export const adminPaths = {
  // =========================================================================
  // Admin users §8.15
  // =========================================================================
  '/admin/users': {
    get: {
      tags: ['Admin'],
      summary: 'List all users (superadmin)',
      description: 'Paginated list of every registered user. Searchable by email or display_name.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'q',
          in: 'query',
          schema: { type: 'string' },
          description: 'Free-text search on email or display_name.',
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
      ],
      responses: {
        '200': {
          description: 'Paginated user list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items', 'next_cursor'],
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AdminUserSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not superadmin)' },
      },
    },
  },
  '/admin/users/{userId}': {
    get: {
      tags: ['Admin'],
      summary: 'User detail with cross-semester memberships (superadmin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'User detail + membership list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AdminUserDetail' },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not superadmin)' },
        '404': { description: 'NOT_FOUND' },
      },
    },
    delete: {
      tags: ['Admin'],
      summary: 'Hard-delete a user (superadmin; cannot delete self)',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '204': { description: 'User deleted' },
        '400': { description: 'VALIDATION_ERROR (cannot delete yourself)' },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not superadmin)' },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },
  '/admin/users/{userId}/protected': {
    patch: {
      tags: ['Admin'],
      summary: 'Set protected flag on a user (superadmin; cannot change own flag)',
      description:
        'Enables or disables the protected flag for the given user. Superadmin cannot change their own flag.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['protected'],
              properties: { protected: { type: 'boolean' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Protected flag updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id', 'protected'],
                properties: {
                  id: { $ref: '#/components/schemas/UUID' },
                  protected: { type: 'boolean' },
                },
              },
            },
          },
        },
        '400': { description: 'VALIDATION_ERROR (cannot change own flag; invalid body)' },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not superadmin)' },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },
  '/admin/view-as': {
    post: {
      tags: ['Admin'],
      summary: 'Enter view-as mode (superadmin; session principals only)',
      description: 'Sets the session to impersonate the given user. Token principals receive 400.',
      security: [{ SessionCookie: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['user_id'],
              properties: { user_id: { $ref: '#/components/schemas/UUID' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'View-as activated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION_ERROR (cannot view-as yourself; token principal)' },
        '401': { description: 'AUTH_REQUIRED' },
        '403': { description: 'INSUFFICIENT_ROLE (not superadmin)' },
        '404': { description: 'NOT_FOUND (target user)' },
      },
    },
  },
  '/admin/view-as/exit': {
    post: {
      tags: ['Admin'],
      summary: 'Exit view-as mode (idempotent)',
      description: 'Clears the view-as flag from the current session. No-op if not in view-as.',
      security: [{ SessionCookie: [] }],
      responses: {
        '204': { description: 'View-as cleared (or was already clear)' },
        '400': { description: 'VALIDATION_ERROR (token principal)' },
        '401': { description: 'AUTH_REQUIRED' },
      },
    },
  },
} as const;
