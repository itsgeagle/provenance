/**
 * Collect the set of third-party extensions that were active during a session,
 * from `ext.snapshot` and `ext.activate` events.
 *
 * Active set = every extension seen with `enabled: true` across `ext.snapshot`
 * events, unioned with any `ext.activate` ids. Deduped by id (latest version
 * seen wins). VS Code built-ins are excluded. Each result carries display-only
 * AI flagging from {@link detectAiExtension}.
 *
 * Takes plain `{ kind, payload }` event objects so it serves both the v3
 * EventRow path and the v2 IndexedEvent path.
 */

import { detectAiExtension } from '@provenance/analysis-core/extensions/detect-ai-extension.js';

export type ActiveExtension = {
  id: string;
  version: string;
  isAi: boolean;
  /** Reason for the AI badge tooltip; present only when isAi. */
  aiReason?: string;
};

/** Minimal event shape — works for both EventRow and IndexedEvent. */
export type EventLike = {
  kind: string;
  payload?: unknown;
};

type ExtSnapshotPayload = {
  extensions?: unknown;
};

type ExtActivatePayload = {
  id?: unknown;
  version?: unknown;
};

/**
 * VS Code built-in publishers, excluded from the active set. `vscode.*` are the
 * bundled built-ins; `ms-vscode.*` and `ms-vscode-remote.*` are Microsoft's
 * bundled tooling/remote publishers.
 */
const BUILTIN_PREFIXES = ['vscode.', 'ms-vscode.', 'ms-vscode-remote.'];

function isBuiltIn(id: string): boolean {
  const lower = id.toLowerCase();
  return BUILTIN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function collectActiveExtensions(
  snapshotEvents: EventLike[],
  activateEvents: EventLike[],
): ActiveExtension[] {
  // id -> version. Events arrive chronologically, so last write wins = latest
  // version seen.
  const versions = new Map<string, string>();

  for (const ev of snapshotEvents) {
    const payload = ev.payload as ExtSnapshotPayload | null;
    const extensions = payload?.extensions;
    if (!Array.isArray(extensions)) continue;
    for (const ext of extensions) {
      if (ext === null || typeof ext !== 'object') continue;
      const e = ext as { id?: unknown; version?: unknown; enabled?: unknown };
      if (e.enabled !== true) continue;
      if (typeof e.id !== 'string' || e.id.length === 0) continue;
      versions.set(e.id, typeof e.version === 'string' ? e.version : '');
    }
  }

  for (const ev of activateEvents) {
    const payload = ev.payload as ExtActivatePayload | null;
    if (typeof payload?.id !== 'string' || payload.id.length === 0) continue;
    versions.set(payload.id, typeof payload.version === 'string' ? payload.version : '');
  }

  const result: ActiveExtension[] = [];
  for (const [id, version] of versions) {
    if (isBuiltIn(id)) continue;
    const detection = detectAiExtension(id);
    result.push({
      id,
      version,
      isAi: detection.isAi,
      ...(detection.reason !== undefined ? { aiReason: detection.reason } : {}),
    });
  }

  // AI first, then alphabetical by id (case-insensitive).
  result.sort((a, b) => {
    if (a.isAi !== b.isAi) return a.isAi ? -1 : 1;
    return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
  });

  return result;
}
