/**
 * explanation-tags.ts — tracks recent "explanation" events for formatter/git operations.
 *
 * When an fs.external_change is detected, the wiring checks whether a known
 * benign operation (formatter run, git op) occurred within a recent time window.
 * If so, the emitted fs.external_change carries an `explanation` field (PRD §4.5:
 * "Anything we can't explain stays flagged").
 *
 * Phase 7: The tagger provides the slot. Phase 8 will hook formatter/git events
 * into it. No automatic detection happens here — callers invoke markFormatter()
 * or markGit() explicitly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExplanationKind = 'formatter' | 'git';

type TagEntry = {
  kind: ExplanationKind;
  at: number; // timestamp from getNow()
};

// ---------------------------------------------------------------------------
// ExplanationTagger
// ---------------------------------------------------------------------------

export class ExplanationTagger {
  private readonly _getNow: () => number;
  private readonly _windowMs: number;
  private _latest: TagEntry | undefined = undefined;

  constructor(deps: { getNow: () => number; windowMs?: number }) {
    this._getNow = deps.getNow;
    this._windowMs = deps.windowMs ?? 2000;
  }

  /** Record that a formatter operation just ran. */
  markFormatter(): void {
    this._latest = { kind: 'formatter', at: this._getNow() };
  }

  /** Record that a git operation just ran. */
  markGit(): void {
    this._latest = { kind: 'git', at: this._getNow() };
  }

  /**
   * Return and clear the most recent tag if it is within the window.
   * One explanation explains one external change (consume-once semantics).
   * Returns undefined if no tag has been set or if the tag has expired.
   */
  consume(): ExplanationKind | undefined {
    if (this._latest === undefined) {
      return undefined;
    }
    const elapsed = this._getNow() - this._latest.at;
    if (elapsed >= this._windowMs) {
      // Expired; clear it so it isn't checked again.
      this._latest = undefined;
      return undefined;
    }
    const kind = this._latest.kind;
    this._latest = undefined;
    return kind;
  }
}
