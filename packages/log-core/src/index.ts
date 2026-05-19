// Events
export type {
  EventKindMap,
  EventKind,
  EventPayload,
  Position,
  Range,
  DocChangeDelta,
  SessionStartPayload,
  SessionHeartbeatPayload,
  SessionEndPayload,
  DocOpenPayload,
  DocChangePayload,
  DocSavePayload,
  DocClosePayload,
  PastePayload,
  SelectionChangePayload,
  FocusChangePayload,
  TerminalOpenPayload,
  TerminalCommandPayload,
  ExtSnapshotPayload,
  ExtActivatePayload,
  FsExternalChangePayload,
  GitEventPayload,
  ClockSkewPayload,
  PasteAnomalyPayload,
  ChainBrokenPayload,
  RecorderDegradedPayload,
  RecorderRecoveredFromCorruptionPayload,
} from './events.js';

// Envelope
export type { Envelope, HashedEnvelope } from './envelope.js';

// Canonicalization
export { canonicalize } from './canonical.js';

// Hash chain
export { chainEntry, sha256Hex, GENESIS_PREV_HASH } from './hash-chain.js';
export type { HashFn } from './hash-chain.js';

// Chain validator
export { validateChain } from './chain-validator.js';
export type { ChainBreak, ValidationResult } from './chain-validator.js';

// Result
export { ok, err } from './result.js';
export type { Result } from './result.js';

// Clock
export { SystemClock, FixedClock } from './clock.js';
export type { Clock } from './clock.js';
