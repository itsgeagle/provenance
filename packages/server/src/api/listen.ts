import {
  existsSync as fsExistsSync,
  unlinkSync as fsUnlinkSync,
  chmodSync as fsChmodSync,
} from 'node:fs';
import type { Env } from '../config/env.js';

/**
 * Where the HTTP server should bind: a Unix domain socket (used behind the
 * EECS apphost's nginx, which proxies to us over a socket with TLS at the
 * edge) or a plain TCP port (local dev, tests).
 */
export type ListenTarget = { kind: 'socket'; path: string } | { kind: 'tcp'; port: number };

/**
 * Chooses a socket over a TCP port whenever `SOCKET_PATH` is set to a
 * non-empty string. Falls back to `PORT` otherwise, preserving today's
 * dev/test behavior when `SOCKET_PATH` is unset.
 */
export function resolveListenTarget(cfg: Pick<Env, 'SOCKET_PATH' | 'PORT'>): ListenTarget {
  if (cfg.SOCKET_PATH !== undefined && cfg.SOCKET_PATH !== '') {
    return { kind: 'socket', path: cfg.SOCKET_PATH };
  }
  return { kind: 'tcp', port: cfg.PORT };
}

interface PrepareSocketFsDeps {
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
}

const defaultPrepareSocketFsDeps: PrepareSocketFsDeps = {
  existsSync: fsExistsSync,
  unlinkSync: fsUnlinkSync,
};

/**
 * Removes a stale socket file left behind by a previous process, so
 * `server.listen(path)` doesn't fail with EADDRINUSE. No-op if the path
 * doesn't exist.
 */
export function prepareSocket(
  path: string,
  fsDeps: PrepareSocketFsDeps = defaultPrepareSocketFsDeps,
): void {
  if (fsDeps.existsSync(path)) {
    fsDeps.unlinkSync(path);
  }
}

interface MakeWorldWritableFsDeps {
  chmodSync: (path: string, mode: number) => void;
}

const defaultMakeWorldWritableFsDeps: MakeWorldWritableFsDeps = {
  chmodSync: fsChmodSync,
};

/**
 * Makes the socket file world-writable (0o777) so the apphost's nginx
 * (running as a different user) can connect to it.
 */
export function makeWorldWritable(
  path: string,
  fsDeps: MakeWorldWritableFsDeps = defaultMakeWorldWritableFsDeps,
): void {
  fsDeps.chmodSync(path, 0o777);
}
