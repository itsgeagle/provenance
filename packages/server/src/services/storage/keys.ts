/**
 * Key builders for the object storage bucket.
 *
 * Single bucket, prefix layout from PRD §6:
 *
 *   semesters/{semesterId}/submissions/{submissionId}/bundle.zip
 *   exports/{exportArtifactId}.{md|pdf}
 *   ingest-staging/{ingestJobId}/{ingestFileId}
 *
 * All functions are pure and take only string args — no I/O, no imports from
 * outside this file. Safe to import anywhere.
 */

/** Key for a submission bundle blob. */
export function bundleKey(semesterId: string, submissionId: string): string {
  return `semesters/${semesterId}/submissions/${submissionId}/bundle.zip`;
}

/**
 * Key for an export artifact blob.
 *
 * @param artifactId - UUID of the export_artifacts row.
 * @param format     - `'md'` or `'pdf'`.
 */
export function exportKey(artifactId: string, format: 'md' | 'pdf'): string {
  return `exports/${artifactId}.${format}`;
}

/**
 * Key for a transient ingest-staging blob.
 * Deleted by the ingest worker once the job reaches terminal status.
 */
export function ingestStagingKey(jobId: string, fileId: string): string {
  return `ingest-staging/${jobId}/${fileId}`;
}
