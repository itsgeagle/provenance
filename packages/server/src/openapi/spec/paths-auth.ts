/**
 * OpenAPI path declarations for §8.1 Auth + §8.12 Tokens.
 */

export const authPaths = {
  '/auth/google/start': {
    post: {
      tags: ['Auth'],
      summary: 'Initiate Google OAuth flow',
      description: 'Returns a 302 redirect to Google. Rate: auth.',
      parameters: [
        {
          name: 'return_to',
          in: 'query',
          schema: { type: 'string' },
          description: 'Same-origin path to redirect to after login.',
        },
      ],
      responses: {
        '302': { description: 'Redirect to Google authorize URL' },
        '400': { description: 'BAD_REQUEST_RETURN_TO_INVALID', $ref: '#/components/schemas/Error' },
      },
    },
  },
  '/auth/google/callback': {
    get: {
      tags: ['Auth'],
      summary: 'Google OAuth callback',
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '302': { description: 'Redirect to return_to; sets session cookie' },
        '400': { description: 'AUTH_OAUTH_STATE_MISMATCH / AUTH_OAUTH_CODE_EXCHANGE_FAILED' },
      },
    },
  },
  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout — invalidate session',
      security: [{ SessionCookie: [] }],
      responses: {
        '204': { description: 'Session invalidated' },
      },
    },
  },
  '/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current principal info',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      responses: {
        '200': {
          description: 'Principal info',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Principal' },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
      },
    },
  },
  '/me/tokens': {
    get: {
      tags: ['Tokens'],
      summary: 'List API tokens for current user',
      security: [{ SessionCookie: [] }],
      responses: {
        '200': {
          description: 'Token list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  tokens: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/TokenSummary' },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
      },
    },
    post: {
      tags: ['Tokens'],
      summary: 'Create a new API token',
      security: [{ SessionCookie: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['label'],
              properties: {
                label: { type: 'string' },
                scopes: { $ref: '#/components/schemas/TokenScopes' },
                expires_at: { $ref: '#/components/schemas/ISODate' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Token created; secret shown once',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { $ref: '#/components/schemas/TokenSummary' },
                  secret: { type: 'string', description: 'Full token secret — shown only here.' },
                },
              },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
      },
    },
  },
  '/me/tokens/{tokenId}': {
    delete: {
      tags: ['Tokens'],
      summary: 'Revoke an API token',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'tokenId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': { description: 'Token revoked' },
        '404': { description: 'Token not found' },
      },
    },
  },
} as const;
