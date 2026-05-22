/**
 * Shared Zod schemas for the Provenance API.
 *
 * These schemas mirror the response shapes returned by the server and are
 * consumed by the analyzer frontend. Both packages import from here so the
 * shape contract is defined in one place.
 *
 * Phase 20: /me, memberships.
 * Phase 21: cohort list (SubmissionRow, CohortListResponse, StudentRollupRow,
 *            CohortFacets, Severity), assignments list.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  is_superadmin: z.boolean(),
  created_at: z.string().datetime(),
  last_login_at: z.string().datetime().nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const TokenScopesSchema = z.object({
  read_only: z.boolean().default(false),
  semester_ids: z.union([z.null(), z.array(z.string().uuid())]).default(null),
  include_blobs: z.boolean().default(false),
});
export type TokenScopes = z.infer<typeof TokenScopesSchema>;

export const MembershipSchema = z.object({
  semester_id: z.string().uuid(),
  semester_slug: z.string(),
  course_slug: z.string(),
  role: z.enum(['admin', 'grader']),
  granted_at: z.string().datetime(),
});
export type Membership = z.infer<typeof MembershipSchema>;

// ---------------------------------------------------------------------------
// /me response
// ---------------------------------------------------------------------------

export const MeResponseSchema = z.discriminatedUnion('principal_kind', [
  z.object({
    principal_kind: z.literal('session'),
    user: UserSchema,
    memberships: z.array(MembershipSchema),
  }),
  z.object({
    principal_kind: z.literal('token'),
    user: UserSchema,
    memberships: z.array(MembershipSchema),
    token: z.object({
      id: z.string().uuid(),
      label: z.string(),
      scopes: TokenScopesSchema,
    }),
  }),
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// Severity + validation status primitives
// ---------------------------------------------------------------------------

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ValidationStatusSchema = z.enum(['pass', 'warn', 'fail']);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — SubmissionRow (PRD §8.8 line 1083+)
// ---------------------------------------------------------------------------

export const SubmissionRowSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  assignment: z.object({
    id: z.string().uuid(),
    assignment_id_str: z.string(),
    label: z.string(),
  }),
  student: z.object({
    id: z.string().uuid(),
    sid: z.string(),
    display_name: z.string(),
  }),
  score_total: z.number(),
  score_max_severity: SeveritySchema,
  flag_counts: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  top_flags: z.array(
    z.object({
      heuristic_id: z.string(),
      severity: SeveritySchema,
    }),
  ),
  validation_status: z.string().nullable(),
  ingested_at: z.string().datetime(),
  recorder_version: z.string().nullable(),
  superseded: z.boolean(),
  recompute_status: z.string(),
});
export type SubmissionRow = z.infer<typeof SubmissionRowSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — CohortFacets + CohortListResponse (PRD §8.8 line 1075+)
// ---------------------------------------------------------------------------

export const CohortFacetsSchema = z.object({
  by_severity: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  by_validation: z.object({
    pass: z.number().int(),
    warn: z.number().int(),
    fail: z.number().int(),
  }),
  by_assignment: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type CohortFacets = z.infer<typeof CohortFacetsSchema>;

export const CohortListResponseSchema = z.object({
  items: z.array(SubmissionRowSchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int(),
  facets: CohortFacetsSchema,
});
export type CohortListResponse = z.infer<typeof CohortListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — StudentRollupRow (PRD §8.8 line 1110+)
// ---------------------------------------------------------------------------

export const StudentRollupRowSchema = z.object({
  student: z.object({
    id: z.string().uuid(),
    sid: z.string(),
    display_name: z.string(),
    email: z.string().optional(),
  }),
  submission_count: z.number().int(),
  score_sum: z.number(),
  score_max: z.number(),
  flag_counts: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  worst_submission: SubmissionRowSchema.nullable(),
  recompute_status: z.string(),
});
export type StudentRollupRow = z.infer<typeof StudentRollupRowSchema>;

export const StudentListResponseSchema = z.object({
  items: z.array(StudentRollupRowSchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int(),
});
export type StudentListResponse = z.infer<typeof StudentListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 21 — Assignment summary row (for filter dropdown)
// ---------------------------------------------------------------------------

export const AssignmentSummarySchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  assignment_id_str: z.string(),
  label: z.string(),
  sort_order: z.number().int(),
  submission_count: z.number().int(),
  distinct_students: z.number().int(),
  mean_score: z.number(),
  median_score: z.number(),
  p95_score: z.number(),
  fail_count: z.number().int(),
  warn_count: z.number().int(),
});
export type AssignmentSummary = z.infer<typeof AssignmentSummarySchema>;

export const AssignmentListResponseSchema = z.object({
  items: z.array(AssignmentSummarySchema),
});
export type AssignmentListResponse = z.infer<typeof AssignmentListResponseSchema>;

// ---------------------------------------------------------------------------
// Ingest / submission stubs (Phase 20 minimal; kept for compatibility)
// ---------------------------------------------------------------------------

export const IngestFileSummarySchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  status: z.string(),
  created_at: z.string().datetime(),
});
export type IngestFileSummary = z.infer<typeof IngestFileSummarySchema>;

export const FlagRowSchema = z.object({
  id: z.string().uuid(),
  heuristic_id: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  confidence: z.number(),
  score_contribution: z.number(),
  detail: z.unknown().nullable(),
});
export type FlagRow = z.infer<typeof FlagRowSchema>;

export const CrossFlagSummarySchema = z.object({
  id: z.string().uuid(),
  heuristic_id: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  participant_count: z.number().int(),
  created_at: z.string().datetime(),
});
export type CrossFlagSummary = z.infer<typeof CrossFlagSummarySchema>;

export const SubmissionSummarySchema = z.object({
  id: z.string().uuid(),
  student: z.object({
    sid: z.string(),
    display_name: z.string(),
  }),
  assignment: z.object({
    assignment_id_str: z.string(),
    label: z.string().nullable(),
  }),
  version_index: z.number().int(),
  score_total: z.number().nullable(),
  score_max_severity: z.string().nullable(),
  validation_status: z.string().nullable(),
  validation_overall_detail: z.string().nullable(),
  heuristic_config_version: z.number().int(),
  flag_count: z.number().int(),
  ingested_at: z.string().datetime(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

export const EventRowSchema = z.object({
  seq: z.number().int(),
  kind: z.string(),
  t: z.number(),
  wall: z.string().datetime(),
  session_id: z.string(),
  payload: z.unknown(),
});
export type EventRow = z.infer<typeof EventRowSchema>;
