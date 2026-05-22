/**
 * SubmissionDataProvider — interface for per-submission data access.
 *
 * Phase 23. Both the API-backed path (ApiSubmissionDataProvider) and the
 * in-memory v2 path (InMemorySubmissionDataProvider) implement this interface.
 * All per-submission view components (Overview, Timeline, Replay, Validation,
 * Export) consume data exclusively through this interface so they can operate
 * in both the v3 API-backed context and the v2 standalone /local context.
 *
 * PRD §14.2 (provider abstraction), Appendix C (module reuse map).
 *
 * Design notes:
 * - All hooks return TanStack Query result shapes so view components can handle
 *   loading/error states uniformly regardless of provider.
 * - For InMemorySubmissionDataProvider, data is available synchronously but we
 *   still wrap it in useQuery to keep the consumer interface identical.
 * - `useEvents` is NOT paginated here; events are returned as a flat array. The
 *   server paginates (PRD §8.9) but the in-memory provider has all events
 *   available. The Timeline and Replay views work with the full event array
 *   once loaded. Full cursor-based pagination is a Phase 24 enhancement.
 */

import { useContext, createContext } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Sub-shapes returned by the provider hooks
// ---------------------------------------------------------------------------

export type PerFileStats = {
  path: string;
  final_length: number;
  saves: number;
  reconstruction_tainted?: boolean;
};

export type SubmissionStats = {
  per_file: PerFileStats[];
  aggregate: {
    total_events: number;
    total_saves: number;
    total_sessions: number;
    total_wall_ms: number;
  };
};

export type ValidationCheckResult = {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  detail?: string | null | undefined;
};

export type ValidationResults = {
  overall: 'pass' | 'warn' | 'fail';
  checks: ValidationCheckResult[];
};

export type FileListResult = {
  files: PerFileStats[];
};

export type FileContentResult = {
  content: string;
  at_seq: number;
  computed_at_ms: number;
  warning?: string | undefined;
};

export type ProvenanceRun = {
  offset: number;
  length: number;
  kind: 'typed' | 'pasted' | 'loaded';
  event_seq: number;
};

export type FileProvenanceResult = {
  length: number;
  provenance: ProvenanceRun[];
  at_seq: number;
};

export type EventQueryFilters = {
  kind?: string[];
  seqFrom?: number;
  seqTo?: number;
  sessionId?: string;
  file?: string;
};

// ---------------------------------------------------------------------------
// SubmissionDataProvider interface
// ---------------------------------------------------------------------------

export interface SubmissionDataProvider {
  /** Submission summary card (PRD §8.9 /summary). */
  useSummary(): UseQueryResult<SubmissionSummary>;

  /** Flat list of events matching optional filters. */
  useEvents(filters: EventQueryFilters): UseQueryResult<EventRow[]>;

  /** Single event by seq. */
  useEvent(seq: number): UseQueryResult<EventRow | null>;

  /** Per-submission heuristic flags. */
  useFlags(): UseQueryResult<FlagRow[]>;

  /** Per-file + aggregate stats. */
  useStats(): UseQueryResult<SubmissionStats>;

  /** Validation check results. */
  useValidation(): UseQueryResult<ValidationResults>;

  /** Files list (paths + basic stats). */
  useFiles(): UseQueryResult<FileListResult>;

  /**
   * File content at a specific event sequence.
   * When atSeq is undefined, the provider returns content at the last save.
   */
  useFileContent(path: string, atSeq?: number): UseQueryResult<FileContentResult>;

  /** File provenance (RLE-encoded attribution runs) at a specific event sequence. */
  useFileProvenance(path: string, atSeq?: number): UseQueryResult<FileProvenanceResult>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const SubmissionDataContext = createContext<SubmissionDataProvider | null>(null);

/**
 * Read the current SubmissionDataProvider from context.
 *
 * Must be called inside a component tree wrapped by either
 * <ApiSubmissionDataProviderContext> or <InMemorySubmissionDataProviderContext>.
 */
export function useSubmissionData(): SubmissionDataProvider {
  const ctx = useContext(SubmissionDataContext);
  if (ctx === null) {
    throw new Error('useSubmissionData must be called inside a SubmissionDataProvider context');
  }
  return ctx;
}
