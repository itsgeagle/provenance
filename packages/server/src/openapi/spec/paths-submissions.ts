/**
 * OpenAPI path declarations for §8.9 Per-submission APIs + §8.11 Heuristic config.
 */

export const submissionsPaths = {
  // =========================================================================
  // Per-submission §8.9
  // =========================================================================
  '/submissions/{submissionId}': {
    get: {
      tags: ['Submissions'],
      summary: 'Submission summary',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Full submission summary',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmissionSummary' },
            },
          },
        },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },
  '/submissions/{submissionId}/flags': {
    get: {
      tags: ['Submissions'],
      summary: 'List per-submission flags (sorted by severity desc)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Flag list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  flags: { type: 'array', items: { $ref: '#/components/schemas/FlagRow' } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/submissions/{submissionId}/stats': {
    get: {
      tags: ['Submissions'],
      summary: 'Per-file stats for a submission',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Per-file stats',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  files: { type: 'array', items: { $ref: '#/components/schemas/PerFileStats' } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/submissions/{submissionId}/validation': {
    get: {
      tags: ['Submissions'],
      summary: 'Validation results for a submission',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Validation results',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ValidationResults' },
            },
          },
        },
      },
    },
  },
  '/submissions/{submissionId}/files': {
    get: {
      tags: ['Submissions'],
      summary: 'List files in a submission',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'File list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/PerFileStats' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/submissions/{submissionId}/events': {
    get: {
      tags: ['Submissions'],
      summary: 'Query events for a submission (paginated, filterable)',
      description: 'Rate: read.detail. Supports cursor pagination, kind/seq/time/session filters.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Repeat for multiple event kinds' },
        { name: 'seq_from', in: 'query', schema: { type: 'integer' } },
        { name: 'seq_to', in: 'query', schema: { type: 'integer' } },
        { name: 'session_id', in: 'query', schema: { type: 'string' } },
        { name: 'file', in: 'query', schema: { type: 'string' }, description: 'Filter by file path' },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 2000 } },
      ],
      responses: {
        '200': {
          description: 'Event list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  events: { type: 'array', items: { $ref: '#/components/schemas/EventRow' } },
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
  '/submissions/{submissionId}/events/{seq}': {
    get: {
      tags: ['Submissions'],
      summary: 'Get a single event by seq',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'seq', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      responses: {
        '200': {
          description: 'Event',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EventRow' } },
          },
        },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },
  '/submissions/{submissionId}/files/{path}/content': {
    get: {
      tags: ['Submissions'],
      summary: 'Reconstructed file content at a given seq',
      description: 'Cache-Control: max-age=60, private. Returns 200 even for tainted files (with warning).',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'URL-encoded file path (may contain slashes)' },
        { name: 'at_seq', in: 'query', schema: { type: 'integer' }, description: 'Event seq at which to reconstruct. Defaults to last doc.save.' },
      ],
      responses: {
        '200': {
          description: 'File content (possibly tainted — check warnings)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  at_seq: { type: 'integer' },
                  warnings: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        message: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '404': { description: 'NOT_FOUND (file path not in submission)' },
      },
    },
  },
  '/submissions/{submissionId}/files/{path}/provenance': {
    get: {
      tags: ['Submissions'],
      summary: 'Per-character provenance map (RLE) for a file',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'at_seq', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        '200': {
          description: 'Provenance RLE runs',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  provenance: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ProvenanceRun' },
                  },
                  warnings: {
                    type: 'array',
                    items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/submissions/{submissionId}/bundle': {
    get: {
      tags: ['Submissions'],
      summary: 'Get a signed download URL for the raw .provenance.zip',
      description: 'Rate: blob.download. Token principals require scopes.include_blobs=true.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'submissionId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '302': { description: 'Redirect to pre-signed S3 URL (valid 5 min)' },
        '403': { description: 'TOKEN_BLOB_NOT_PERMITTED' },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },

  // =========================================================================
  // Heuristic config §8.11
  // =========================================================================
  '/semesters/{semesterId}/heuristic-config': {
    get: {
      tags: ['HeuristicConfig'],
      summary: 'Get active heuristic config for a semester',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'semesterId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Active heuristic config',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HeuristicConfigSummary' },
            },
          },
        },
      },
    },
    put: {
      tags: ['HeuristicConfig'],
      summary: 'Dry-run or commit a new heuristic config version (semester admin)',
      description: 'Add ?dryRun=true to preview the diff without committing. Requires If-Match header with current version.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'semesterId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'dryRun', in: 'query', schema: { type: 'boolean', default: false } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                per_flag: { type: 'object', additionalProperties: true },
                severity_weights: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Dry-run diff or committed config' },
        '409': { description: 'CONFIG_VERSION_CONFLICT (If-Match mismatch)' },
        '428': { description: 'PRECONDITION_REQUIRED (missing If-Match)' },
      },
    },
  },
  '/semesters/{semesterId}/heuristic-configs': {
    get: {
      tags: ['HeuristicConfig'],
      summary: 'List heuristic config history',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'semesterId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Config history',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  configs: { type: 'array', items: { $ref: '#/components/schemas/HeuristicConfigSummary' } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/recompute': {
    post: {
      tags: ['HeuristicConfig'],
      summary: 'Enqueue a semester-wide recompute job (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'semesterId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '202': {
          description: 'Recompute job accepted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { recompute_job_id: { $ref: '#/components/schemas/UUID' } },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/recompute/{jobId}': {
    get: {
      tags: ['HeuristicConfig'],
      summary: 'Poll recompute job status',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        { name: 'semesterId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'jobId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
      ],
      responses: {
        '200': {
          description: 'Recompute job status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProvenanceRun2' },
            },
          },
        },
      },
    },
  },
} as const;
