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
