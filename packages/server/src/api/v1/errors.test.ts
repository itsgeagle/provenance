/**
 * Error taxonomy tests — every code in PRD §17 has a factory,
 * and the factory produces the correct status and code.
 */

import { describe, it, expect } from 'vitest';
import { ApiError, Errors, type ApiErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function roundtrip(err: ApiError): { code: ApiErrorCode; status: number; hasDetails: boolean } {
  const body = err.toBody();
  return {
    code: body.error.code,
    status: err.status,
    hasDetails: body.error.details !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Auth errors
// ---------------------------------------------------------------------------

describe('Auth error factories', () => {
  it('authRequired — 401 AUTH_REQUIRED', () => {
    const err = Errors.authRequired('/api/v1/auth/google/start?return_to=%2F');
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.status).toBe(401);
    expect(err.details?.login_url).toContain('/api/v1/auth/google/start');
  });

  it('oauthStateMismatch — 400 AUTH_OAUTH_STATE_MISMATCH', () => {
    const r = roundtrip(Errors.oauthStateMismatch());
    expect(r.code).toBe('AUTH_OAUTH_STATE_MISMATCH');
    expect(r.status).toBe(400);
  });

  it('oauthCodeExchangeFailed — 502 AUTH_OAUTH_CODE_EXCHANGE_FAILED', () => {
    const r = roundtrip(Errors.oauthCodeExchangeFailed('timeout'));
    expect(r.code).toBe('AUTH_OAUTH_CODE_EXCHANGE_FAILED');
    expect(r.status).toBe(502);
    expect(r.hasDetails).toBe(true);
  });

  it('oauthCodeExchangeFailed without cause — no details', () => {
    const r = roundtrip(Errors.oauthCodeExchangeFailed());
    expect(r.hasDetails).toBe(false);
  });

  it('domainNotAllowed — 403 AUTH_DOMAIN_NOT_ALLOWED', () => {
    const r = roundtrip(Errors.domainNotAllowed());
    expect(r.code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    expect(r.status).toBe(403);
  });

  it('emailNotVerified — 403 AUTH_EMAIL_NOT_VERIFIED', () => {
    const r = roundtrip(Errors.emailNotVerified());
    expect(r.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Token authorization
// ---------------------------------------------------------------------------

describe('Token authorization error factories', () => {
  it('tokenReadOnly — 403 TOKEN_READ_ONLY', () => {
    const r = roundtrip(Errors.tokenReadOnly());
    expect(r.code).toBe('TOKEN_READ_ONLY');
    expect(r.status).toBe(403);
  });

  it('tokenScopeOutOfBand — 403 TOKEN_SCOPE_OUT_OF_BAND', () => {
    const err = Errors.tokenScopeOutOfBand('semester-uuid-1');
    expect(err.code).toBe('TOKEN_SCOPE_OUT_OF_BAND');
    expect(err.status).toBe(403);
    expect(err.details?.semester_id).toBe('semester-uuid-1');
  });

  it('tokenBlobNotPermitted — 403 TOKEN_BLOB_NOT_PERMITTED', () => {
    const r = roundtrip(Errors.tokenBlobNotPermitted());
    expect(r.code).toBe('TOKEN_BLOB_NOT_PERMITTED');
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Role / membership
// ---------------------------------------------------------------------------

describe('Role / membership error factories', () => {
  it('notAMember — 403 NOT_A_MEMBER', () => {
    const r = roundtrip(Errors.notAMember());
    expect(r.code).toBe('NOT_A_MEMBER');
    expect(r.status).toBe(403);
  });

  it('insufficientRole — 403 INSUFFICIENT_ROLE', () => {
    const err = Errors.insufficientRole('admin');
    expect(err.code).toBe('INSUFFICIENT_ROLE');
    expect(err.status).toBe(403);
    expect(err.details?.required_role).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

describe('Request validation error factories', () => {
  it('badReturnTo — 400 BAD_REQUEST_RETURN_TO_INVALID', () => {
    const r = roundtrip(Errors.badReturnTo());
    expect(r.code).toBe('BAD_REQUEST_RETURN_TO_INVALID');
    expect(r.status).toBe(400);
  });

  it('validation — 400 VALIDATION with issues', () => {
    const err = Errors.validation([{ path: 'x', message: 'Required' }]);
    expect(err.code).toBe('VALIDATION');
    expect(err.status).toBe(400);
    expect(Array.isArray(err.details?.issues)).toBe(true);
  });

  it('validationRegex — 400 VALIDATION_REGEX', () => {
    const err = Errors.validationRegex('filename_convention', '[invalid');
    expect(err.code).toBe('VALIDATION_REGEX');
    expect(err.status).toBe(400);
    expect(err.details?.field).toBe('filename_convention');
    expect(err.details?.pattern).toBe('[invalid');
  });
});

// ---------------------------------------------------------------------------
// Resource not found
// ---------------------------------------------------------------------------

describe('Not found error factories', () => {
  it('notFound — 404 NOT_FOUND', () => {
    const r = roundtrip(Errors.notFound());
    expect(r.code).toBe('NOT_FOUND');
    expect(r.status).toBe(404);
  });

  it('fileNotFound — 404 FILE_NOT_FOUND', () => {
    const err = Errors.fileNotFound('file-id-1');
    expect(err.code).toBe('FILE_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.details?.file_id).toBe('file-id-1');
  });

  it('fileNotFound without id — no details', () => {
    const r = roundtrip(Errors.fileNotFound());
    expect(r.hasDetails).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conflict (409)
// ---------------------------------------------------------------------------

describe('Conflict error factories', () => {
  it('courseSlugTaken — 409', () => {
    const err = Errors.courseSlugTaken('cs61a');
    expect(err.code).toBe('COURSE_SLUG_TAKEN');
    expect(err.status).toBe(409);
    expect(err.details?.slug).toBe('cs61a');
  });

  it('semesterSlugTaken — 409', () => {
    const err = Errors.semesterSlugTaken('fa26');
    expect(err.code).toBe('SEMESTER_SLUG_TAKEN');
    expect(err.status).toBe(409);
  });

  it('memberAlready — 409', () => {
    const err = Errors.memberAlready('user-id', 'semester-id');
    expect(err.code).toBe('MEMBER_ALREADY');
    expect(err.status).toBe(409);
  });

  it('invitationAlreadyOpen — 409', () => {
    const err = Errors.invitationAlreadyOpen('user@berkeley.edu', 'semester-id');
    expect(err.code).toBe('INVITATION_ALREADY_OPEN');
    expect(err.status).toBe(409);
  });

  it('cannotDemoteSelf — 409', () => {
    const r = roundtrip(Errors.cannotDemoteSelf());
    expect(r.code).toBe('CANNOT_DEMOTE_SELF');
    expect(r.status).toBe(409);
  });

  it('lastAdminRequired — 409', () => {
    const r = roundtrip(Errors.lastAdminRequired());
    expect(r.code).toBe('LAST_ADMIN_REQUIRED');
    expect(r.status).toBe(409);
  });

  it('ingestFileNotUnmatched — 409', () => {
    const err = Errors.ingestFileNotUnmatched('file-id');
    expect(err.code).toBe('INGEST_FILE_NOT_UNMATCHED');
    expect(err.status).toBe(409);
  });

  it('configVersionConflict — 409', () => {
    const err = Errors.configVersionConflict(5);
    expect(err.code).toBe('CONFIG_VERSION_CONFLICT');
    expect(err.status).toBe(409);
    expect(err.details?.current_version).toBe(5);
  });

  it('idempotencyKeyReused — 409', () => {
    const err = Errors.idempotencyKeyReused('my-key');
    expect(err.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    expect(err.status).toBe(409);
    expect(err.details?.idempotency_key).toBe('my-key');
  });
});

// ---------------------------------------------------------------------------
// Payload too large (413)
// ---------------------------------------------------------------------------

describe('Payload too large error factories', () => {
  it('rosterCsvTooLarge — 413', () => {
    const err = Errors.rosterCsvTooLarge(1024 * 1024);
    expect(err.code).toBe('ROSTER_CSV_TOO_LARGE');
    expect(err.status).toBe(413);
    expect(err.details?.max_bytes).toBe(1024 * 1024);
  });

  it('ingestBatchTooLarge — 413', () => {
    const err = Errors.ingestBatchTooLarge(50 * 1024 * 1024);
    expect(err.code).toBe('INGEST_BATCH_TOO_LARGE');
    expect(err.status).toBe(413);
  });

  it('ingestFileTooLarge — 413', () => {
    const err = Errors.ingestFileTooLarge(10 * 1024 * 1024);
    expect(err.code).toBe('INGEST_FILE_TOO_LARGE');
    expect(err.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Bad request (400)
// ---------------------------------------------------------------------------

describe('Bad request error factories', () => {
  it('rosterCsvMissingRequiredColumn — 400', () => {
    const err = Errors.rosterCsvMissingRequiredColumn('email');
    expect(err.code).toBe('ROSTER_CSV_MISSING_REQUIRED_COLUMN');
    expect(err.status).toBe(400);
    expect(err.details?.column).toBe('email');
  });

  it('rosterCsvParse — 400', () => {
    const err = Errors.rosterCsvParse('unexpected EOF');
    expect(err.code).toBe('ROSTER_CSV_PARSE');
    expect(err.status).toBe(400);
  });

  it('ingestTooManyFiles — 400', () => {
    const err = Errors.ingestTooManyFiles(150, 100);
    expect(err.code).toBe('INGEST_TOO_MANY_FILES');
    expect(err.status).toBe(400);
    expect(err.details?.count).toBe(150);
    expect(err.details?.max).toBe(100);
  });

  it('eventQueryLimitExceeded — 400', () => {
    const err = Errors.eventQueryLimitExceeded(5000);
    expect(err.code).toBe('EVENT_QUERY_LIMIT_EXCEEDED');
    expect(err.status).toBe(400);
  });

  it('eventQueryRangeInvalid — 400', () => {
    const err = Errors.eventQueryRangeInvalid('end before start');
    expect(err.code).toBe('EVENT_QUERY_RANGE_INVALID');
    expect(err.status).toBe(400);
  });

  it('exportFormatUnsupported — 400', () => {
    const err = Errors.exportFormatUnsupported('xyz');
    expect(err.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
    expect(err.status).toBe(400);
    expect(err.details?.format).toBe('xyz');
  });
});

// ---------------------------------------------------------------------------
// Semantic validation (422)
// ---------------------------------------------------------------------------

describe('Semantic validation error factories', () => {
  it('rosterRequired — 422', () => {
    const r = roundtrip(Errors.rosterRequired());
    expect(r.code).toBe('ROSTER_REQUIRED');
    expect(r.status).toBe(422);
  });

  it('heuristicConfigInvalid — 422', () => {
    const err = Errors.heuristicConfigInvalid('unknown heuristic id: foo');
    expect(err.code).toBe('HEURISTIC_CONFIG_INVALID');
    expect(err.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Server errors (500, 503)
// ---------------------------------------------------------------------------

describe('Server error factories', () => {
  it('exportRenderFailed — 500', () => {
    const err = Errors.exportRenderFailed('req-id-1');
    expect(err.code).toBe('EXPORT_RENDER_FAILED');
    expect(err.status).toBe(500);
  });

  it('internal — 500', () => {
    const err = Errors.internal('req-id', 'Error: at line 5');
    expect(err.code).toBe('INTERNAL');
    expect(err.status).toBe(500);
    expect(err.details?.request_id).toBe('req-id');
    expect(err.details?.stack).toBe('Error: at line 5');
  });

  it('internal without args — no details', () => {
    const r = roundtrip(Errors.internal());
    expect(r.code).toBe('INTERNAL');
    expect(r.status).toBe(500);
    expect(r.hasDetails).toBe(false);
  });

  it('dependencyUnavailable — 503', () => {
    const err = Errors.dependencyUnavailable('postgres');
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(err.status).toBe(503);
    expect(err.details?.dependency).toBe('postgres');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (429)
// ---------------------------------------------------------------------------

describe('Rate limiting error factory', () => {
  it('rateLimited — 429 RATE_LIMITED with retry_after and reset_at', () => {
    const err = Errors.rateLimited(30, 1748000000);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(429);
    expect(err.details?.retry_after_seconds).toBe(30);
    expect(err.details?.reset_at).toBe(1748000000);
  });
});

// ---------------------------------------------------------------------------
// ApiError.toBody() round-trip
// ---------------------------------------------------------------------------

describe('ApiError.toBody()', () => {
  it('omits details key when no details', () => {
    const err = new ApiError('NOT_FOUND', 404, 'Resource not found');
    const body = err.toBody();
    expect('details' in body.error).toBe(false);
  });

  it('includes details when present', () => {
    const err = new ApiError('VALIDATION', 400, 'Bad input', { field: 'email' });
    const body = err.toBody();
    expect(body.error.details).toEqual({ field: 'email' });
  });
});
