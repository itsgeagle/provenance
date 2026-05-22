/**
 * OpenAPI path declarations for §8.5 Assignments + §8.6 Ingest + §8.7 Unmatched.
 */

export const ingestPaths = {
  // =========================================================================
  // Assignments §8.5
  // =========================================================================
  '/semesters/{semesterId}/assignments': {
    get: {
      tags: ['Assignments'],
      summary: 'List assignments with summary stats',
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
          description: 'Assignment list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  assignments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { $ref: '#/components/schemas/UUID' },
                        semester_id: { $ref: '#/components/schemas/UUID' },
                        assignment_id_str: { type: 'string' },
                        label: { type: 'string' },
                        sort_order: { type: 'integer' },
                        submission_count: { type: 'integer' },
                        distinct_students: { type: 'integer' },
                        mean_score: { type: 'number' },
                        median_score: { type: 'number' },
                        p95_score: { type: 'number' },
                        fail_count: { type: 'integer' },
                        warn_count: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/assignments/{assignmentId}': {
    patch: {
      tags: ['Assignments'],
      summary: 'Update assignment label or sort order (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'assignmentId',
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
                label: { type: 'string' },
                sort_order: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Assignment updated' },
      },
    },
  },

  // =========================================================================
  // Ingest §8.6
  // =========================================================================
  '/semesters/{semesterId}/ingest': {
    post: {
      tags: ['Ingest'],
      summary: 'Start an ingest job (semester admin)',
      description:
        'Upload one or more .zip bundles (or a single zip-of-zips). Returns 202 immediately; processing is async.',
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
              properties: {
                'files[]': { type: 'array', items: { type: 'string', format: 'binary' } },
                archive: { type: 'string', format: 'binary' },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { job_id: { $ref: '#/components/schemas/UUID' } },
              },
            },
          },
        },
        '413': { description: 'INGEST_BATCH_TOO_LARGE or INGEST_FILE_TOO_LARGE' },
        '422': { description: 'ROSTER_REQUIRED (no roster uploaded yet)' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs': {
    get: {
      tags: ['Ingest'],
      summary: 'List ingest jobs (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Paginated ingest jobs',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestJobSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}': {
    get: {
      tags: ['Ingest'],
      summary: 'Get ingest job detail + first 200 files',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Ingest job detail',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/IngestJobSummary' },
                  {
                    type: 'object',
                    properties: {
                      files: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/IngestFileSummary' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}/files': {
    get: {
      tags: ['Ingest'],
      summary: 'Paginated file list for an ingest job',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: {
        '200': {
          description: 'File list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestFileSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}/cancel': {
    post: {
      tags: ['Ingest'],
      summary: 'Cancel an in-progress ingest job (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '202': { description: 'Cancellation accepted' },
        '409': { description: 'INGEST_JOB_NOT_CANCELLABLE (already terminal)' },
      },
    },
  },

  // =========================================================================
  // Unmatched §8.7
  // =========================================================================
  '/semesters/{semesterId}/unmatched': {
    get: {
      tags: ['Unmatched'],
      summary: 'List unmatched ingest files (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Unmatched files',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestFileSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/unmatched/{ingestFileId}': {
    patch: {
      tags: ['Unmatched'],
      summary: 'Manually attach unmatched file (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'ingestFileId',
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
              required: ['student_id', 'assignment_id_str'],
              properties: {
                student_id: { $ref: '#/components/schemas/UUID' },
                assignment_id_str: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'File matched; new IngestFileSummary returned',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/IngestFileSummary' },
            },
          },
        },
        '404': { description: 'ROSTER_ENTRY_NOT_FOUND' },
        '409': { description: 'INGEST_FILE_NOT_UNMATCHED' },
      },
    },
  },
  '/semesters/{semesterId}/unmatched/{ingestFileId}/discard': {
    post: {
      tags: ['Unmatched'],
      summary: 'Discard an unmatched file (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'ingestFileId',
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
              properties: { reason: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'File discarded' },
      },
    },
  },
} as const;
