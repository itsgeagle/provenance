import type { NotifyEvent } from './types.js';
import type { Severity } from './severity.js';

/**
 * A notify event rendered into sink-agnostic plain text plus a Discord-shaped
 * `content` string (Slack-compatible incoming webhooks accept the same shape).
 */
export interface RenderedEvent {
  severity: Severity;
  kind: string;
  title: string;
  text: string;
  discordContent: string;
}

const EMOJI: Record<Severity, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };

export function renderEvent(e: NotifyEvent): RenderedEvent {
  const detailStr =
    e.detail && Object.keys(e.detail).length
      ? '\n' + Object.entries(e.detail).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
      : '';
  const text = `[${e.severity.toUpperCase()}] ${e.kind} — ${e.title}${detailStr}`;
  const discordContent = `${EMOJI[e.severity]} **[${e.severity.toUpperCase()}] ${e.title}**\n\`${e.kind}\`${detailStr}`;
  return { severity: e.severity, kind: e.kind, title: e.title, text, discordContent };
}
