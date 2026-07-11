/**
 * Builders for the process-lifecycle notifications (`app.startup` /
 * `app.shutdown`).
 *
 * Since the apphost runs the same image as separate `api` and (scaled)
 * `worker` processes, a single restart emits several of these events. The role
 * (`mode`) is put in the TITLE so they're scannable in the webhook/Discord
 * feed, and the container `host` is carried in the detail so individual worker
 * replicas are distinguishable ("which worker restarted?"). Kept as pure
 * builders, separate from index.ts, so the event shape is unit-testable
 * without booting the process.
 */

import type { NotifyEvent } from './types.js';

export function startupEvent(args: {
  mode: string;
  sha: string | undefined;
  backend: string;
  host: string;
}): NotifyEvent {
  return {
    severity: 'info',
    kind: 'app.startup',
    title: `Provenance ${args.mode} started`,
    detail: {
      mode: args.mode,
      sha: args.sha ?? 'unknown',
      backend: args.backend,
      host: args.host,
    },
  };
}

export function shutdownEvent(args: { mode: string; signal: string; host: string }): NotifyEvent {
  return {
    severity: 'info',
    kind: 'app.shutdown',
    title: `Provenance ${args.mode} shutting down (${args.signal})`,
    detail: {
      mode: args.mode,
      signal: args.signal,
      host: args.host,
    },
  };
}
