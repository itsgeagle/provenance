/**
 * Invitation email template.
 *
 * Builds plain-text and minimal HTML invitation emails.
 *
 * Design:
 * - No templating library dependency; uses a tiny escape helper to prevent
 *   XSS from user-supplied fields (email address, courseSlug, semesterSlug).
 * - Subject includes course + semester slugs for easy identification.
 * - Body includes the role and a login URL (same for all invitations — users
 *   log in via Google and the pending row is consumed on first matching email).
 */

export type Role = 'admin' | 'grader';

export interface BuildInvitationEmailArgs {
  recipientEmail: string;
  invitedBy: string;      // display name or email of the person who invited
  courseSlug: string;
  semesterSlug: string;
  role: Role;
  loginUrl: string;       // PUBLIC_BASE_URL + /login
}

export interface InvitationEmailContent {
  subject: string;
  text: string;
  html: string;
}

// ---------------------------------------------------------------------------
// HTML escape helper — prevents injection from user-supplied fields
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent injection.
 * Only used for values that originate from user input (email addresses, slugs).
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Template builder
// ---------------------------------------------------------------------------

/**
 * Builds the subject, plain-text body, and HTML body for an invitation email.
 *
 * The loginUrl is the same for all invitations. When the invited user first
 * signs in via Google, the pending_invitations row for their email is consumed
 * and they receive the membership immediately.
 */
export function buildInvitationEmail(args: BuildInvitationEmailArgs): InvitationEmailContent {
  const { recipientEmail, invitedBy, courseSlug, semesterSlug, role, loginUrl } = args;

  const subject = `You've been invited to ${courseSlug}/${semesterSlug} as ${role}`;

  const text = [
    `Hello ${recipientEmail},`,
    '',
    `${invitedBy} has invited you to join ${courseSlug} (${semesterSlug}) as a ${role}.`,
    '',
    'To accept this invitation, sign in with your Google account at:',
    loginUrl,
    '',
    'Your access will be granted automatically when you first log in.',
    '',
    '—',
    'Provenance',
  ].join('\n');

  const safeEmail = escapeHtml(recipientEmail);
  const safeInvitedBy = escapeHtml(invitedBy);
  const safeCourse = escapeHtml(courseSlug);
  const safeSemester = escapeHtml(semesterSlug);
  const safeRole = escapeHtml(role);
  const safeLoginUrl = escapeHtml(loginUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Invitation to ${safeCourse}/${safeSemester}</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
  <p>Hello <strong>${safeEmail}</strong>,</p>
  <p>
    <strong>${safeInvitedBy}</strong> has invited you to join
    <strong>${safeCourse}/${safeSemester}</strong> as a <strong>${safeRole}</strong>.
  </p>
  <p>
    To accept this invitation, sign in with your Google account:
  </p>
  <p>
    <a href="${safeLoginUrl}" style="
      display: inline-block;
      padding: 10px 20px;
      background: #1a73e8;
      color: #ffffff;
      text-decoration: none;
      border-radius: 4px;
    ">Sign in with Google</a>
  </p>
  <p style="color: #666; font-size: 0.9em;">
    Your access will be granted automatically when you first log in.<br>
    If the button doesn't work, copy this URL into your browser:<br>
    <code>${safeLoginUrl}</code>
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="color: #999; font-size: 0.8em;">Provenance</p>
</body>
</html>`;

  return { subject, text, html };
}
