/**
 * Drizzle ORM table definitions for Provenance Analyzer v3.
 *
 * Schema follows PRD §5.1 (identity & structure) and §4.2 (sessions) exactly.
 *
 * Design notes:
 * - Enums (role, term) are text columns with CHECK constraints — NOT Postgres enum
 *   types. This matches the PRD §5.1 explicit note and avoids DDL pain when
 *   adding values.
 * - gen_random_uuid() is built into Postgres 16 (no extension needed).
 * - Functional indexes (LOWER(email), LOWER(email) + semester_id) and the partial
 *   unique index on pending_invitations are defined in the migration SQL directly
 *   since drizzle-kit cannot generate those expressions fully. The schema file
 *   carries column-level unique constraints where Drizzle supports them; the
 *   expression-based indexes are in 0001_init.sql.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  index,
  primaryKey,
  inet,
  check,
  unique,
  jsonb,
  bigint,
  bigserial,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// users  (PRD §5.1)
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    google_subject: text('google_subject').notNull().unique(),
    email: text('email').notNull(),
    display_name: text('display_name').notNull().default(''),
    is_superadmin: boolean('is_superadmin').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
  },
  // users_email_lower_idx is a functional index (LOWER(email)) and is defined
  // in the migration SQL; Drizzle cannot express functional indexes in the schema.
);

// ---------------------------------------------------------------------------
// sessions  (PRD §4.2)
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: inet('ip'),
    user_agent: text('user_agent'),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.user_id),
    index('sessions_expires_at_idx').on(t.expires_at),
  ],
);

// ---------------------------------------------------------------------------
// courses  (PRD §5.1)
// ---------------------------------------------------------------------------

export const courses = pgTable('courses', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// semesters  (PRD §5.1)
// ---------------------------------------------------------------------------

export const semesters = pgTable(
  'semesters',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    course_id: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    term: text('term').notNull(),
    year: integer('year').notNull(),
    slug: text('slug').notNull(),
    display_name: text('display_name').notNull(),
    filename_convention: text('filename_convention').notNull(),
    blob_retention_days: integer('blob_retention_days').notNull().default(540),
    derived_retention_days: integer('derived_retention_days').notNull().default(1825),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('semesters_course_id_slug_key').on(t.course_id, t.slug),
    check('semesters_term_check', sql`${t.term} IN ('fa','sp','su','wi')`),
    check('semesters_year_check', sql`${t.year} BETWEEN 2000 AND 2100`),
    check('semesters_blob_retention_check', sql`${t.blob_retention_days} >= 30`),
    check(
      'semesters_derived_retention_check',
      sql`${t.derived_retention_days} >= ${t.blob_retention_days}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// memberships  (PRD §5.1)
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  'memberships',
  {
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    granted_by: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    granted_at: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.semester_id] }),
    index('memberships_semester_id_idx').on(t.semester_id),
    check('memberships_role_check', sql`${t.role} IN ('admin','grader')`),
  ],
);

// ---------------------------------------------------------------------------
// pending_invitations  (PRD §4.4)
// ---------------------------------------------------------------------------

export const pending_invitations = pgTable(
  'pending_invitations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    invited_by: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('pending_invitations_role_check', sql`${t.role} IN ('admin','grader')`),
    // pending_invitations_unique_open is a partial unique index on
    // (LOWER(email), semester_id) WHERE consumed_at IS NULL.
    // Drizzle cannot express partial indexes in the schema; it is created
    // in the migration SQL directly.
  ],
);

// ---------------------------------------------------------------------------
// api_tokens  (PRD §4.3)
// ---------------------------------------------------------------------------

export const api_tokens = pgTable(
  'api_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    prefix: text('prefix').notNull().unique(),
    hashed_token: text('hashed_token').notNull(),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'{}'`),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.user_id)],
);

// ---------------------------------------------------------------------------
// roster_entries  (PRD §5.2 / migration 0005)
// ---------------------------------------------------------------------------

/**
 * One row per student enrolled in a semester, keyed by `sid`.
 * Populated via CSV upload + commit (§8.4). `sid` is unique per semester.
 */
export const roster_entries = pgTable(
  'roster_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    sid: text('sid').notNull(),
    display_name: text('display_name').notNull(),
    email: text('email'),
    extras: jsonb('extras')
      .notNull()
      .default(sql`'{}'`),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('roster_entries_semester_sid_key').on(t.semester_id, t.sid),
    index('roster_entries_semester_id_idx').on(t.semester_id),
  ],
);

// ---------------------------------------------------------------------------
// rate_limit_buckets  (PRD §7.6 / migration 0003)
// ---------------------------------------------------------------------------

/**
 * Postgres-backed rate limit bucket state.
 *
 * Used only when RATE_LIMIT_BACKEND=postgres (production multi-process).
 * The in-memory backend does not touch this table.
 *
 * `principal_id` format:
 *   "user:<uuid>"   — session-authenticated user
 *   "token:<uuid>"  — token-authenticated principal
 *   "anon:<ip>"     — unauthenticated, keyed by IP address
 */
export const rate_limit_buckets = pgTable(
  'rate_limit_buckets',
  {
    principal_id: text('principal_id').notNull(),
    route_class: text('route_class').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    last_refill_at: timestamp('last_refill_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.principal_id, t.route_class] })],
);

// ---------------------------------------------------------------------------
// audit_log  (PRD §5.7 / migration 0004)
// ---------------------------------------------------------------------------

/**
 * Append-only audit trail of all write actions and sensitive read actions.
 * See PRD §13 for the action catalog and retention policy.
 *
 * Rows are NEVER deleted by application code; only the retention sweep removes
 * them after max(semester.derived_retention_days, 1825) days.
 */
export const audit_log = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor_user_id: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actor_token_id: uuid('actor_token_id').references(() => api_tokens.id, {
      onDelete: 'set null',
    }),
    semester_id: uuid('semester_id').references(() => semesters.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'`),
    ip: inet('ip'),
    user_agent: text('user_agent'),
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('audit_log_semester_at_idx').on(t.semester_id, t.at),
    index('audit_log_actor_at_idx').on(t.actor_user_id, t.at),
    index('audit_log_action_at_idx').on(t.action, t.at),
  ],
);

// ---------------------------------------------------------------------------
// assignments  (PRD §5.2 / migration 0006)
// ---------------------------------------------------------------------------

/**
 * One row per unique assignment within a semester.
 * `assignment_id_str` is the canonical string id from the bundle manifest.
 * `label` is human-readable and editable by admins.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    assignment_id_str: text('assignment_id_str').notNull(),
    label: text('label').notNull().default(''),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique('assignments_semester_assignment_key').on(t.semester_id, t.assignment_id_str)],
);

// ---------------------------------------------------------------------------
// ingest_jobs  (PRD §5.3 / migration 0006)
// ---------------------------------------------------------------------------

export const ingest_jobs = pgTable(
  'ingest_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    uploaded_by: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'`),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    // ingest_jobs_semester_id_idx: defined in SQL with DESC ordering;
    // Drizzle cannot express DESC in index definition, so we omit it here.
    check(
      'ingest_jobs_status_check',
      sql`${t.status} IN ('queued','running','succeeded','partial','failed','cancelled')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// submissions  (PRD §5.4 / migration 0006)
// ---------------------------------------------------------------------------

/**
 * One row per (semester, assignment, student, version_index) tuple.
 * Partial covering index `submissions_cohort_idx` is SQL-only (WHERE clause).
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    assignment_id: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'restrict' }),
    student_id: uuid('student_id')
      .notNull()
      .references(() => roster_entries.id, { onDelete: 'restrict' }),
    blob_object_key: text('blob_object_key').notNull(),
    blob_sha256: text('blob_sha256').notNull(),
    recorder_version: text('recorder_version').notNull().default(''),
    format_version: text('format_version').notNull().default(''),
    source_filename: text('source_filename').notNull(),
    // Forward reference: ingest_jobs is declared later but FK is fine in SQL.
    ingest_job_id: uuid('ingest_job_id')
      .notNull()
      .references(() => ingest_jobs.id, { onDelete: 'restrict' }),
    ingested_at: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version_index: integer('version_index').notNull(),
    superseded_by_submission_id: uuid('superseded_by_submission_id'),
    score_total: doublePrecision('score_total').notNull().default(0),
    score_max_severity: text('score_max_severity').notNull().default('info'),
    validation_status: text('validation_status').notNull().default('pending'),
    heuristic_config_version: integer('heuristic_config_version').notNull().default(0),
    recompute_status: text('recompute_status').notNull().default('fresh'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('submissions_version_key').on(
      t.semester_id,
      t.assignment_id,
      t.student_id,
      t.version_index,
    ),
    index('submissions_student_idx').on(t.semester_id, t.student_id),
    index('submissions_blob_sha_idx').on(t.semester_id, t.blob_sha256),
    check(
      'submissions_score_max_severity_check',
      sql`${t.score_max_severity} IN ('info','low','medium','high')`,
    ),
    check(
      'submissions_validation_status_check',
      sql`${t.validation_status} IN ('pending','pass','warn','fail')`,
    ),
    check(
      'submissions_recompute_status_check',
      sql`${t.recompute_status} IN ('fresh','stale','recomputing','error')`,
    ),
    // submissions_cohort_idx (partial) is SQL-only; defined in migration 0006.
  ],
);

// Self-referential FK: submissions.superseded_by_submission_id -> submissions.id
// Cannot express this in Drizzle with references(() => submissions.id) at declaration
// time because the table isn't fully built yet. The FK is defined in the SQL migration.

// ---------------------------------------------------------------------------
// ingest_files  (PRD §5.3 / migration 0006)
// ---------------------------------------------------------------------------

export const ingest_files = pgTable(
  'ingest_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ingest_job_id: uuid('ingest_job_id')
      .notNull()
      .references(() => ingest_jobs.id, { onDelete: 'cascade' }),
    original_filename: text('original_filename').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    blob_sha256: text('blob_sha256').notNull(),
    status: text('status').notNull(),
    matched_student_id: uuid('matched_student_id').references(() => roster_entries.id, {
      onDelete: 'set null',
    }),
    matched_assignment_id: uuid('matched_assignment_id').references(() => assignments.id, {
      onDelete: 'set null',
    }),
    submission_id: uuid('submission_id').references(() => submissions.id, { onDelete: 'set null' }),
    filename_capture: jsonb('filename_capture'),
    error: jsonb('error'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    resolved_by: uuid('resolved_by').references(() => users.id),
  },
  (t) => [
    index('ingest_files_job_idx').on(t.ingest_job_id),
    index('ingest_files_blob_sha256_idx').on(t.blob_sha256),
    // ingest_files_unmatched_idx (partial) is SQL-only; defined in migration 0006.
    check(
      'ingest_files_status_check',
      sql`${t.status} IN ('pending','matched','unmatched','duplicate','failed','superseded','discarded')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// events  (PRD §5.4 / migration 0007)
// ---------------------------------------------------------------------------

/**
 * One row per event in the log-core hash chain, indexed chronologically.
 *
 * `seq` is the global chronological index across all sessions within the
 * submission (IndexedEvent.globalIdx from v2 buildIndex), NOT the
 * session-local seq from the bundle envelope.
 *
 * `payload` is the raw event data object from the bundle envelope, stored as
 * jsonb for structured queries.
 *
 * `prev_hash` + `hash` carry the log-core hash-chain values from
 * HashedEnvelope, enabling server-side chain verification.
 */
export const events = pgTable(
  'events',
  {
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    session_id: text('session_id').notNull(),
    t: integer('t').notNull(),
    wall: timestamp('wall', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    prev_hash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.submission_id, t.seq] }),
    index('events_sub_kind_t_idx').on(t.submission_id, t.kind, t.t),
    index('events_sub_t_idx').on(t.submission_id, t.t),
    index('events_sub_session_seq_idx').on(t.submission_id, t.session_id, t.seq),
  ],
);

// ---------------------------------------------------------------------------
// per_file_stats  (PRD §5.4 / migration 0007)
// ---------------------------------------------------------------------------

/**
 * One row per (submission, file_path) with aggregated editing statistics.
 *
 * `final_length` and `start_length` are stored as 0 at ingest time.
 * Computing them requires file reconstruction (Phase 18).
 *
 * `reconstruction_tainted` is true if reconstructFile reported taint (large
 * paste or external change) for this file.
 */
export const per_file_stats = pgTable(
  'per_file_stats',
  {
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    file_path: text('file_path').notNull(),
    chars_typed: integer('chars_typed').notNull().default(0),
    chars_pasted: integer('chars_pasted').notNull().default(0),
    chars_external_change_delta: integer('chars_external_change_delta').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    final_length: integer('final_length').notNull().default(0),
    start_length: integer('start_length').notNull().default(0),
    reconstruction_tainted: boolean('reconstruction_tainted').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.submission_id, t.file_path] })],
);

// ---------------------------------------------------------------------------
// validation_results  (PRD §5.4 / migration 0008)
// ---------------------------------------------------------------------------

/**
 * One row per submission with the results of running v2's runValidation.
 *
 * The 8 check_N_status columns correspond to PRD §5.4 spec order:
 *   1. manifest_sig        5. monotonic_t
 *   2. session_binding     6. monotonic_wall
 *   3. chain_integrity     7. doc_save_hashes
 *   4. seq_gaps            8. submitted_code_match  (always 'skipped' in v1)
 *
 * CHECK constraints accept all four possible values ('pass'|'fail'|'warn'|'skipped');
 * the SQL migration is the authority. Drizzle check() helpers are omitted here
 * to keep the schema concise — the migration enforces them at the DB layer.
 *
 * `detail` stores the full ValidationReport.checks array for human-readable
 * display by the API without re-running validation.
 */
export const validation_results = pgTable('validation_results', {
  submission_id: uuid('submission_id')
    .primaryKey()
    .references(() => submissions.id, { onDelete: 'cascade' }),
  check_1_status: text('check_1_status').notNull(),
  check_2_status: text('check_2_status').notNull(),
  check_3_status: text('check_3_status').notNull(),
  check_4_status: text('check_4_status').notNull(),
  check_5_status: text('check_5_status').notNull(),
  check_6_status: text('check_6_status').notNull(),
  check_7_status: text('check_7_status').notNull(),
  check_8_status: text('check_8_status').notNull(),
  overall: text('overall').notNull(),
  detail: jsonb('detail')
    .notNull()
    .default(sql`'{}'`),
  validated_at: timestamp('validated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// flags  (PRD §5.4 / migration 0009)
// ---------------------------------------------------------------------------

/**
 * One row per heuristic finding on a submission.
 *
 * A single heuristic can fire multiple flags per submission (e.g. large_paste
 * fires once per paste event above threshold), so the PK is gen_random_uuid()
 * rather than a composite key.
 *
 * `supporting_seqs` is int[] of globalIdx values (events.seq) that
 * contributed to this flag. Translated from v2's `${sessionId}:${seq}` string
 * keys by buildIndex.bySeq at ingest time.
 *
 * `session_id`: set to the sessionId when all supporting_seqs belong to
 * the same session; otherwise '' (the default). This lets the API
 * deep-link into a specific session timeline without decoding supporting_seqs.
 *
 * CHECK constraints are defined in the SQL migration; omitted from Drizzle to
 * keep the schema concise (V27 convention).
 */
export const flags = pgTable(
  'flags',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    heuristic_id: text('heuristic_id').notNull(),
    severity: text('severity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    weight_at_compute: doublePrecision('weight_at_compute').notNull(),
    score_contribution: doublePrecision('score_contribution').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'`),
    supporting_seqs: integer('supporting_seqs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    session_id: text('session_id').notNull().default(''),
    heuristic_config_version: integer('heuristic_config_version').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('flags_sub_idx').on(t.submission_id),
    index('flags_sem_heur_idx').on(t.semester_id, t.heuristic_id),
    index('flags_sem_sev_idx').on(t.semester_id, t.severity),
  ],
);

// ---------------------------------------------------------------------------
// Re-exported for convenience
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Semester = typeof semesters.$inferSelect;
export type NewSemester = typeof semesters.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type PendingInvitation = typeof pending_invitations.$inferSelect;
export type NewPendingInvitation = typeof pending_invitations.$inferInsert;
export type ApiToken = typeof api_tokens.$inferSelect;
export type NewApiToken = typeof api_tokens.$inferInsert;
export type RateLimitBucket = typeof rate_limit_buckets.$inferSelect;
export type NewRateLimitBucket = typeof rate_limit_buckets.$inferInsert;
export type RosterEntry = typeof roster_entries.$inferSelect;
export type NewRosterEntry = typeof roster_entries.$inferInsert;
export type AuditLog = typeof audit_log.$inferSelect;
export type NewAuditLog = typeof audit_log.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type IngestJob = typeof ingest_jobs.$inferSelect;
export type NewIngestJob = typeof ingest_jobs.$inferInsert;
export type IngestFile = typeof ingest_files.$inferSelect;
export type NewIngestFile = typeof ingest_files.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type PerFileStat = typeof per_file_stats.$inferSelect;
export type NewPerFileStat = typeof per_file_stats.$inferInsert;
export type ValidationResult = typeof validation_results.$inferSelect;
export type NewValidationResult = typeof validation_results.$inferInsert;
export type Flag = typeof flags.$inferSelect;
export type NewFlag = typeof flags.$inferInsert;
