/**
 * Shared link bases for node detail panels.
 *
 * Kept in one place because the group files are authored independently — the
 * repo has already moved GitHub orgs once, and thirteen copies of the same
 * base URL would guarantee a partial update next time.
 */

/** Blob root of the main monorepo on `main`. */
export const GH = 'https://github.com/ProvenanceTools/provenance/blob/main';

/** Blob root of the Gradescope gateway (`provgate`), a separate repo. */
export const GH_PROVGATE =
  'https://github.com/ProvenanceTools/provenance-gradescope-gateway/blob/main';
