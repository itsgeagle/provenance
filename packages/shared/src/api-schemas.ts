/**
 * Shared Zod schemas for the Provenance API.
 *
 * These schemas mirror the response shapes returned by the server and are
 * consumed by the analyzer frontend. Both packages import from here so the
 * shape contract is defined in one place.
 *
 * Only schemas needed by Phase 20 endpoints (/me, memberships) are populated
 * here. Later phases will extend this file as new endpoints are consumed by
 * the frontend.
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
// Semester / Course (derived from /me memberships — no separate endpoint)
//
// The server exposes semester/course data as part of MeResponse.memberships.
// A "semester" for the frontend is constructed from a membership row.
// ---------------------------------------------------------------------------

export const SemesterSummarySchema = z.object({
  semester_id: z.string().uuid(),
  semester_slug: z.string(),
  course_slug: z.string(),
  role: z.enum(['admin', 'grader']),
  granted_at: z.string().datetime(),
});
export type SemesterSummary = z.infer<typeof SemesterSummarySchema>;

// ---------------------------------------------------------------------------
// Submission/ingest schemas (minimal stubs for Phase 20)
//
// These will be expanded in Phases 21–24 as the cohort view and drill-in
// views consume more API endpoints.
// ---------------------------------------------------------------------------

export const IngestFileSummarySchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  status: z.string(),
  created_at: z.string().datetime(),
});
export type IngestFileSummary = z.infer<typeof IngestFileSummarySchema>;

export const SubmissionRowSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  assignment_id: z.string().uuid(),
  student_id: z.string().uuid(),
  version_index: z.number().int(),
  score_total: z.number().nullable(),
  validation_status: z.string().nullable(),
  ingested_at: z.string().datetime(),
});
export type SubmissionRow = z.infer<typeof SubmissionRowSchema>;

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
