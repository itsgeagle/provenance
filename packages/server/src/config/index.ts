import { parseEnv, type Env } from './env.js';

let _config: Env | undefined;

/**
 * Returns the validated config singleton.
 * Reads from `process.env` on first call; subsequent calls return the cached value.
 */
export function getConfig(): Env {
  if (_config === undefined) {
    _config = parseEnv(process.env);
  }
  return _config;
}

// Allow resetting the singleton in tests that need to swap configs.
// Not part of the public API for production code.
export function _resetConfigForTest(): void {
  _config = undefined;
}
