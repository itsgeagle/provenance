/**
 * Error taxonomy for Provenance Analyzer v3 API.
 *
 * Shape follows PRD §7.3:
 *   { "error": { "code": string, "message": string, "details"?: object } }
 *
 * Phase 2 covers AUTH codes. Additional codes will be added per-phase.
 */

// ---------------------------------------------------------------------------
// Error codes (machine-readable)
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  // Auth
  | 'AUTH_REQUIRED'
  | 'AUTH_OAUTH_STATE_MISMATCH'
  | 'AUTH_OAUTH_CODE_EXCHANGE_FAILED'
  | 'AUTH_DOMAIN_NOT_ALLOWED'
  | 'AUTH_EMAIL_NOT_VERIFIED'
  // Request validation
  | 'BAD_REQUEST_RETURN_TO_INVALID'
  | 'VALIDATION'
  // Resource errors
  | 'NOT_FOUND';

// ---------------------------------------------------------------------------
// ApiError class
// ---------------------------------------------------------------------------

/**
 * Structured API error that can be serialized to the §7.3 error shape.
 *
 * Throw ApiError from route handlers; the error-handling middleware
 * (to be added in Phase 4) converts it to a JSON response.  For Phase 2,
 * route handlers catch it and call `.toResponse()` inline.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /**
   * Serializes to the PRD §7.3 error-response shape.
   */
  toBody(): ErrorResponseBody {
    const err: ErrorObject = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      err.details = this.details;
    }
    return { error: err };
  }
}

// ---------------------------------------------------------------------------
// Response shape (PRD §7.3)
// ---------------------------------------------------------------------------

interface ErrorObject {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponseBody {
  error: ErrorObject;
}

// ---------------------------------------------------------------------------
// Factory helpers for Phase 2 errors
// ---------------------------------------------------------------------------

export const Errors = {
  authRequired(loginPath: string): ApiError {
    return new ApiError('AUTH_REQUIRED', 401, 'Authentication required', {
      login_url: loginPath,
    });
  },

  oauthStateMismatch(): ApiError {
    return new ApiError('AUTH_OAUTH_STATE_MISMATCH', 400, 'OAuth state mismatch');
  },

  oauthCodeExchangeFailed(cause?: string): ApiError {
    return new ApiError(
      'AUTH_OAUTH_CODE_EXCHANGE_FAILED',
      502,
      'Failed to exchange OAuth code with Google',
      cause ? { cause } : undefined,
    );
  },

  domainNotAllowed(): ApiError {
    return new ApiError('AUTH_DOMAIN_NOT_ALLOWED', 403, 'Google Workspace domain not permitted');
  },

  emailNotVerified(): ApiError {
    return new ApiError('AUTH_EMAIL_NOT_VERIFIED', 403, 'Google account email is not verified');
  },

  badReturnTo(): ApiError {
    return new ApiError(
      'BAD_REQUEST_RETURN_TO_INVALID',
      400,
      'return_to must be a same-origin path starting with /',
    );
  },

  notFound(): ApiError {
    return new ApiError('NOT_FOUND', 404, 'Resource not found (or not visible)');
  },
} as const;
