/**
 * Protected-mode masking helpers (pure).
 *
 * When a request's principal is protected, student identity must never leave
 * the server. These helpers substitute stable, name-independent placeholders.
 * The label is derived from roster_entries.protected_index; if that is somehow
 * null, it falls back to a short slice of the (random, non-PII) UUID so masking
 * can never degrade to real PII.
 *
 * Spec: docs/superpowers/specs/2026-06-17-protected-mode-design.md
 */

function uuidStub(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

export function protectedLabel(index: number | null | undefined, id: string): string {
  return typeof index === 'number' ? `Student ${index}` : `Student ${uuidStub(id)}`;
}

export function protectedSid(index: number | null | undefined, id: string): string {
  return typeof index === 'number' ? `S${index}` : `S-${uuidStub(id)}`;
}

export interface CoreStudentInput {
  id: string;
  sid: string;
  display_name: string;
  protected_index: number | null;
}

export interface CoreStudent {
  id: string;
  sid: string;
  display_name: string;
}

export function projectStudent(input: CoreStudentInput, protectedMode: boolean): CoreStudent {
  if (!protectedMode) {
    return { id: input.id, sid: input.sid, display_name: input.display_name };
  }
  return {
    id: input.id,
    sid: protectedSid(input.protected_index, input.id),
    display_name: protectedLabel(input.protected_index, input.id),
  };
}

export function maskEmail(email: string | null | undefined, protectedMode: boolean): string | null {
  return protectedMode ? null : (email ?? null);
}

export function maskExtras<T>(extras: T, protectedMode: boolean): T | null {
  return protectedMode ? null : extras;
}

export function maskFilename(name: string, protectedMode: boolean, label: string): string {
  return protectedMode ? label : name;
}
