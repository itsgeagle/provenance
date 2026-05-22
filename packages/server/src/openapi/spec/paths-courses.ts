/**
 * OpenAPI path declarations for §8.2 Courses & Semesters.
 */

export const coursesPaths = {
  '/courses': {
    get: {
      tags: ['Courses'],
      summary: 'List courses visible to the principal',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      responses: {
        '200': {
          description: 'Course list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  courses: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { $ref: '#/components/schemas/UUID' },
                        name: { type: 'string' },
                        slug: { type: 'string' },
                        archived: { type: 'boolean' },
                        semesters_count: { type: 'integer' },
                      },
                    },
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
      tags: ['Courses'],
      summary: 'Create a course (superadmin only)',
      security: [{ SessionCookie: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'slug'],
              properties: {
                name: { type: 'string' },
                slug: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Course created' },
        '409': { description: 'COURSE_SLUG_TAKEN' },
      },
    },
  },
  '/courses/{courseId}': {
    get: {
      tags: ['Courses'],
      summary: 'Get course by ID',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'courseId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': { description: 'Course detail' },
        '404': { description: 'NOT_FOUND' },
      },
    },
    patch: {
      tags: ['Courses'],
      summary: 'Update course (superadmin only)',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'courseId',
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
              properties: { name: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Course updated' },
      },
    },
  },
  '/courses/{courseId}/archive': {
    post: {
      tags: ['Courses'],
      summary: 'Archive course (superadmin only)',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'courseId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '204': { description: 'Course archived' },
      },
    },
  },
  '/courses/{courseId}/semesters': {
    get: {
      tags: ['Semesters'],
      summary: 'List semesters for a course',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'courseId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Semester list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  semesters: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/SemesterSummary' },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['Semesters'],
      summary: 'Create a semester (superadmin only)',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'courseId',
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
              required: ['term', 'year', 'slug', 'display_name', 'filename_convention'],
              properties: {
                term: { type: 'string', enum: ['fa', 'sp', 'su', 'wi'] },
                year: { type: 'integer' },
                slug: { type: 'string' },
                display_name: { type: 'string' },
                filename_convention: { type: 'string' },
                blob_retention_days: { type: 'integer' },
                derived_retention_days: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Semester created' },
        '400': { description: 'VALIDATION_REGEX (invalid filename_convention)' },
        '409': { description: 'SEMESTER_SLUG_TAKEN' },
      },
    },
  },
  '/semesters/{semesterId}': {
    get: {
      tags: ['Semesters'],
      summary: 'Get semester by ID',
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
          description: 'Semester detail (includes filename_convention, retention days)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SemesterSummary' },
            },
          },
        },
        '404': { description: 'NOT_FOUND' },
      },
    },
    patch: {
      tags: ['Semesters'],
      summary: 'Update semester (semester admin)',
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
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                display_name: { type: 'string' },
                filename_convention: { type: 'string' },
                blob_retention_days: { type: 'integer' },
                derived_retention_days: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Semester updated' },
      },
    },
  },
  '/semesters/{semesterId}/archive': {
    post: {
      tags: ['Semesters'],
      summary: 'Archive semester (superadmin only)',
      security: [{ SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '204': { description: 'Semester archived' },
      },
    },
  },
} as const;
