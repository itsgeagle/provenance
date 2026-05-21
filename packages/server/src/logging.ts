import pino, { type Logger } from 'pino';
import { getConfig } from './config/index.js';

let _logger: Logger | undefined;

/**
 * Returns the root pino logger singleton.
 * JSON output; log level driven by `LOG_LEVEL` env var.
 */
export function getLogger(): Logger {
  if (_logger === undefined) {
    const cfg = getConfig();
    _logger = pino({ level: cfg.LOG_LEVEL });
  }
  return _logger;
}

/**
 * Returns a child logger with a `request_id` field bound to every log line.
 * Used inside request handlers to correlate logs back to a single HTTP request.
 */
export function requestLogger(requestId: string): Logger {
  return getLogger().child({ request_id: requestId });
}

// Allow resetting the singleton in tests.
export function _resetLoggerForTest(): void {
  _logger = undefined;
}
