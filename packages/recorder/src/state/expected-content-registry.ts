/**
 * ExpectedContentRegistry — maps relative file paths to their ExpectedContent instances.
 * Only maintains state for files in the manifest's files_under_review list (PRD §4.5).
 */

import { ExpectedContent } from './expected-content.js';

export class ExpectedContentRegistry {
  private readonly _watched: ReadonlySet<string>;
  private readonly _map = new Map<string, ExpectedContent>();

  constructor(filesUnderReview: readonly string[]) {
    this._watched = new Set(filesUnderReview);
  }

  /** Whether a path is in the files_under_review list. */
  isWatched(relativePath: string): boolean {
    return this._watched.has(relativePath);
  }

  /**
   * Get or create the ExpectedContent for a relative path.
   * If the path already exists in the registry, returns the existing instance.
   * If it's new, creates one with initialContent.
   */
  getOrCreate(relativePath: string, initialContent: string): ExpectedContent {
    const existing = this._map.get(relativePath);
    if (existing !== undefined) {
      return existing;
    }
    const ec = new ExpectedContent(initialContent);
    this._map.set(relativePath, ec);
    return ec;
  }

  /** Get the ExpectedContent for a path, or undefined if not tracked. */
  get(relativePath: string): ExpectedContent | undefined {
    return this._map.get(relativePath);
  }

  /** Remove the ExpectedContent entry for a path. */
  delete(relativePath: string): void {
    this._map.delete(relativePath);
  }
}
