/**
 * Detect *transient* database failures — ones a job should retry rather than
 * treat as a permanent, data-related failure.
 *
 * During a large ingest the connection pools can momentarily saturate
 * ("sorry, too many clients already"), or Postgres may briefly restart / drop a
 * socket. Those errors are infrastructure hiccups: the same operation will
 * succeed once pressure clears. Callers use this to re-throw (so pg-boss retries
 * with backoff) instead of marking work permanently failed and silently dropping
 * it.
 */

/**
 * SQLSTATEs that indicate a transient condition: connection exhaustion, server
 * starting/shutting down, the connection-exception class (08xxx), and
 * serialization/deadlock (retryable by definition).
 */
const RETRYABLE_SQLSTATES = new Set([
  '53300', // too_many_connections  ("sorry, too many clients already")
  '53400', // configuration_limit_exceeded
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (server still starting)
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Node / postgres.js connection-level error codes (no SQLSTATE). */
const RETRYABLE_CONN_CODES = new Set([
  'CONNECTION_ENDED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

const RETRYABLE_MESSAGE_RE =
  /too many clients|connection terminated|connection closed|connection ended|ECONNRESET|ETIMEDOUT/i;

/**
 * True when `err`, or any error in its `cause` chain, is a transient
 * infrastructure failure. Drizzle wraps the driver error in a DrizzleQueryError,
 * and the per-phase ingest handlers re-wrap with only the message, so we inspect
 * both `code` and the message text down the chain (bounded depth).
 */
export function isTransientDbError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 6; depth++) {
    if (typeof cur !== 'object') break;
    const code = (cur as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_CONN_CODES.has(code))
    ) {
      return true;
    }
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string' && RETRYABLE_MESSAGE_RE.test(message)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
