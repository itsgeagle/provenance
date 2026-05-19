/**
 * Discriminated union of all Provenance log event types.
 * PRD §4.2 (v1 event table) + §4.3 / §4.6 / §4.8 additive events.
 */

// ---------------------------------------------------------------------------
// Shared geometry types
// ---------------------------------------------------------------------------

export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

// ---------------------------------------------------------------------------
// Per-event payload types
// ---------------------------------------------------------------------------

export type SessionStartPayload = {
  format_version: string;
  session_id: string;
  prev_session_id: string | null;
  assignment: { id: string; semester: string };
  manifest_sig: string;
  machine_id: string;
  vscode: {
    version: string;
    /**
     * VS Code build commit hash (40-char hex, shown in Help → About).
     * The vscode public API does not expose this, so the recorder emits the
     * empty string. Analyzers must accept `''` as valid here.
     */
    commit: string;
    platform: string;
  };
  recorder: { version: string; extension_id: string };
  session_pubkey: string;
};

export type SessionHeartbeatPayload = {
  focused: boolean;
  active_file: string | null;
  idle_since_ms: number;
};

export type SessionEndPayload = {
  reason: string;
};

export type DocOpenPayload = {
  path: string;
  sha256: string;
  line_count: number;
};

export type DocChangeDelta = {
  range: Range;
  text: string;
};

export type DocChangePayload = {
  path: string;
  deltas: Array<DocChangeDelta>;
  source: 'typed' | 'paste_likely' | 'paste_confirmed';
};

export type DocSavePayload = {
  path: string;
  sha256: string;
};

export type DocClosePayload = {
  path: string;
};

export type PastePayload = {
  path: string;
  range: Range;
  length: number;
  sha256: string;
  content?: string;
  content_head?: string;
  content_tail?: string;
};

export type SelectionChangePayload = {
  path: string;
  range: Range;
  was_selection: boolean;
};

export type FocusChangePayload = {
  gained: boolean;
  reason?: string;
};

export type TerminalOpenPayload = {
  terminal_id: string;
  shell: string;
  shell_integration: boolean;
};

export type TerminalCommandPayload = {
  terminal_id: string;
  command: string;
  exit_code?: number;
};

export type ExtSnapshotPayload = {
  extensions: Array<{ id: string; version: string; enabled: boolean }>;
};

export type ExtActivatePayload = {
  id: string;
  version: string;
};

export type FsExternalChangePayload = {
  path: string;
  old_hash: string;
  new_hash: string;
  diff_size: number;
  explanation?: 'formatter' | 'git';
};

export type GitEventPayload = {
  operation: string;
  commit_sha?: string;
};

export type ClockSkewPayload = {
  delta_ms: number;
};

// v1-additive events (PRD §4.3, §4.6, §4.8)

export type PasteAnomalyPayload = {
  intercepted_count: number;
  large_insert_count: number;
};

export type ChainBrokenPayload = {
  at_seq: number;
  reason: string;
};

export type RecorderDegradedPayload = {
  reason: string;
};

export type RecorderRecoveredFromCorruptionPayload = {
  quarantined_path: string;
};

// ---------------------------------------------------------------------------
// Discriminated union map and derived types
// ---------------------------------------------------------------------------

export type EventKindMap = {
  'session.start': SessionStartPayload;
  'session.heartbeat': SessionHeartbeatPayload;
  'session.end': SessionEndPayload;
  'doc.open': DocOpenPayload;
  'doc.change': DocChangePayload;
  'doc.save': DocSavePayload;
  'doc.close': DocClosePayload;
  paste: PastePayload;
  'selection.change': SelectionChangePayload;
  'focus.change': FocusChangePayload;
  'terminal.open': TerminalOpenPayload;
  'terminal.command': TerminalCommandPayload;
  'ext.snapshot': ExtSnapshotPayload;
  'ext.activate': ExtActivatePayload;
  'fs.external_change': FsExternalChangePayload;
  'git.event': GitEventPayload;
  'clock.skew': ClockSkewPayload;
  'paste.anomaly': PasteAnomalyPayload;
  'chain.broken': ChainBrokenPayload;
  'recorder.degraded': RecorderDegradedPayload;
  'recorder.recovered_from_corruption': RecorderRecoveredFromCorruptionPayload;
};

/** All valid event kind strings. */
export type EventKind = keyof EventKindMap;

/** Look up the payload type for a given event kind. */
export type EventPayload<K extends EventKind> = EventKindMap[K];
