import type { Severity } from './severity.js';
import type { RenderedEvent } from './render.js';

/**
 * A single operational event to notify on.
 */
export interface NotifyEvent {
  severity: Severity;
  /** Stable machine key, e.g. 'app.startup', 'job.dead_letter'. */
  kind: string;
  /** One-line human summary. */
  title: string;
  /** Structured context; must be safe to serialize (JSON.stringify). */
  detail?: Record<string, unknown>;
  /** Dedupe/throttle key; defaults to `kind` when omitted (dedup lands in a later task). */
  dedupeKey?: string;
}

/**
 * A notification destination. Each sink declares its own minimum severity
 * threshold; an event reaches a sink only when `meets(event.severity, sink.minSeverity)`.
 */
export interface Sink {
  name: string;
  minSeverity: Severity;
  send(rendered: RenderedEvent): Promise<void>;
}

/**
 * The notify() façade. `notify` is fire-and-forget: it never throws and never
 * blocks the caller. `flush` awaits all in-flight sink sends (used on shutdown/crash).
 */
export interface Notifier {
  notify(e: NotifyEvent): void;
  flush(): Promise<void>;
}
