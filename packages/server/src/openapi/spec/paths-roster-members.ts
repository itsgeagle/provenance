/**
 * OpenAPI path declarations for §8.3 Members + §8.4 Roster.
 */

export const rosterMembersPaths = {
  // =========================================================================
  // Members §8.3
  // =========================================================================
  '/semesters/{semesterId}/members': {
    get: {
      tags: ['Members'],
      summary: 'List semester members and pending invitations',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Members + pending invitations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  members: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        user_id: { $ref: '#/components/schemas/UUID' },
                        email: { type: 'string' },
                        display_name: { type: 'string' },
                        role: { $ref: '#/components/schemas/Role' },
                        granted_at: { $ref: '#/components/schemas/ISODate' },
                        granted_by_email: { type: 'string' },
                      },
                    },
                  },
                  pending: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { $ref: '#/components/schemas/UUID' },
                        email: { type: 'string' },
                        role: { $ref: '#/components/schemas/Role' },
                        invited_at: { $ref: '#/components/schemas/ISODate' },
                        invited_by_email: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'AUTH_REQUIRED' },
        '404': { description: 'NOT_A_MEMBER' },
      },
    },
    post: {
      tags: ['Members'],
      summary: 'Invite or add a member (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
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
              required: ['email', 'role'],
              properties: {
                email: { type: 'string', format: 'email' },
                role: { $ref: '#/components/schemas/Role' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Member added or invitation sent' },
        '409': { description: 'MEMBER_ALREADY or INVITATION_ALREADY_OPEN' },
      },
    },
  },
  '/semesters/{semesterId}/members/{userId}': {
    patch: {
      tags: ['Members'],
      summary: 'Change member role (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
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
              required: ['role'],
              properties: { role: { $ref: '#/components/schemas/Role' } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Role updated' },
        '409': { description: 'CANNOT_DEMOTE_SELF or LAST_ADMIN_REQUIRED' },
      },
    },
    delete: {
      tags: ['Members'],
      summary: 'Remove member (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '204': { description: 'Member removed' },
        '409': { description: 'LAST_ADMIN_REQUIRED' },
      },
    },
  },
  '/semesters/{semesterId}/invitations/{invitationId}': {
    delete: {
      tags: ['Members'],
      summary: 'Cancel a pending invitation (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'invitationId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '204': { description: 'Invitation cancelled' },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },

  // =========================================================================
  // Roster §8.4
  // =========================================================================
  '/semesters/{semesterId}/roster': {
    get: {
      tags: ['Roster'],
      summary: 'List roster entries (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        {
          name: 'q',
          in: 'query',
          schema: { type: 'string' },
          description: 'Free-text search on display_name or email',
        },
      ],
      responses: {
        '200': {
          description: 'Roster entries',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  entries: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/RosterEntry' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  total_count: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/roster:upload': {
    post: {
      tags: ['Roster'],
      summary: 'Upload roster CSV — returns diff preview (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Diff preview with upload_id, parsed_rows, to_add, to_update, to_delete, errors',
        },
        '413': { description: 'ROSTER_CSV_TOO_LARGE' },
      },
    },
  },
  '/semesters/{semesterId}/roster:commit': {
    post: {
      tags: ['Roster'],
      summary: 'Commit roster upload (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
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
              required: ['upload_id', 'accept_deletions'],
              properties: {
                upload_id: { $ref: '#/components/schemas/UUID' },
                accept_deletions: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Roster committed; applied counts returned' },
      },
    },
  },
  '/semesters/{semesterId}/roster/{rosterEntryId}': {
    patch: {
      tags: ['Roster'],
      summary: 'Update a roster entry (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'rosterEntryId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                display_name: { type: 'string' },
                email: { type: 'string' },
                extras: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Roster entry updated' },
      },
    },
  },
} as const;
