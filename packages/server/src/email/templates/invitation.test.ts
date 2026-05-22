/**
 * Invitation email template tests.
 */

import { describe, it, expect } from 'vitest';
import { buildInvitationEmail } from './invitation.js';

const BASE_ARGS = {
  recipientEmail: 'student@berkeley.edu',
  invitedBy: 'Professor Smith',
  courseSlug: 'cs61a',
  semesterSlug: 'fa2024',
  role: 'grader' as const,
  loginUrl: 'http://localhost:3000/login',
};

describe('buildInvitationEmail', () => {
  it('subject contains course slug + semester slug', () => {
    const { subject } = buildInvitationEmail(BASE_ARGS);
    expect(subject).toContain('cs61a');
    expect(subject).toContain('fa2024');
  });

  it('text includes role + login URL', () => {
    const { text } = buildInvitationEmail(BASE_ARGS);
    expect(text).toContain('grader');
    expect(text).toContain('http://localhost:3000/login');
  });

  it('html includes role + login URL', () => {
    const { html } = buildInvitationEmail(BASE_ARGS);
    expect(html).toContain('grader');
    expect(html).toContain('http://localhost:3000/login');
  });

  it('admin role appears in subject and body', () => {
    const { subject, text, html } = buildInvitationEmail({ ...BASE_ARGS, role: 'admin' });
    expect(subject).toContain('admin');
    expect(text).toContain('admin');
    expect(html).toContain('admin');
  });

  it('HTML escapes special characters in email to prevent injection', () => {
    const { html } = buildInvitationEmail({
      ...BASE_ARGS,
      recipientEmail: '<script>alert(1)</script>@evil.com',
    });
    // Should NOT contain a raw <script> tag in HTML output.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML escapes special characters in courseSlug to prevent injection', () => {
    const { html } = buildInvitationEmail({
      ...BASE_ARGS,
      courseSlug: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('text contains recipient email', () => {
    const { text } = buildInvitationEmail(BASE_ARGS);
    expect(text).toContain('student@berkeley.edu');
  });

  it('text contains invitedBy name', () => {
    const { text } = buildInvitationEmail(BASE_ARGS);
    expect(text).toContain('Professor Smith');
  });

  it('returns all three fields: subject, text, html', () => {
    const result = buildInvitationEmail(BASE_ARGS);
    expect(result).toHaveProperty('subject');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('html');
    expect(typeof result.subject).toBe('string');
    expect(typeof result.text).toBe('string');
    expect(typeof result.html).toBe('string');
  });
});
