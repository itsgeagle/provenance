/**
 * ExportPanel — submission export tab.
 *
 * Phase 24. Replaces ExportStub.
 *
 * Features:
 * - Format selector: markdown (sync) or PDF (async).
 * - "Generate Export" button → POST /submissions/:id/export.
 * - Markdown (sync): response includes download_url → triggers download immediately.
 * - PDF (async): response includes job_id → poll until status='succeeded' → prompt download.
 *
 * NOTE: The POST /submissions/:id/export endpoint is not yet implemented server-side
 * (Phase 25 carry-over). This component stubs the mutation for UI purposes; the server
 * will return the appropriate response shape when the export service is added.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useStartExport } from '../../api/queries.js';
import type { ExportJob } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Type guard for discriminated union
// ---------------------------------------------------------------------------

function isSyncResult(job: ExportJob): job is ExportJob & { type: 'sync' } {
  return job.type === 'sync';
}

// ---------------------------------------------------------------------------
// PDF async polling (simple timer-based — no React Query for the poll since
// there's no stable endpoint for status; the export server endpoint carries
// the job status as part of the initial response or a separate poll endpoint).
// Phase 25 can extend this with a dedicated useExportJobStatus hook once the
// server implements GET /submissions/:id/export/:jobId.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30; // 60 seconds

// ---------------------------------------------------------------------------
// ExportPanel
// ---------------------------------------------------------------------------

export function ExportPanel() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();

  const [format, setFormat] = useState<'markdown' | 'pdf'>('markdown');
  const [pollStatus, setPollStatus] = useState<'idle' | 'polling' | 'ready' | 'error'>('idle');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pollAttemptsRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const exportMutation = useStartExport(submissionId);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  function triggerDownload(url: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function handleGenerate() {
    setErrorMsg(null);
    setDownloadUrl(null);
    setPollStatus('idle');
    pollAttemptsRef.current = 0;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);

    try {
      const result = await exportMutation.mutateAsync(format);

      if (isSyncResult(result)) {
        // Markdown (sync): trigger download immediately
        triggerDownload(result.data.download_url);
        setDownloadUrl(result.data.download_url);
        setPollStatus('ready');
      } else {
        // PDF (async): start polling
        setPollStatus('polling');
        // NOTE: Phase 25 will add GET /submissions/:id/export/:jobId polling.
        // For Phase 24, we simulate the async flow with a stub that resolves
        // after a short delay (no real poll endpoint yet).
        schedulePoll(result.data.job_id);
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      setErrorMsg(e.message ?? 'Export failed. Please try again.');
      setPollStatus('error');
    }
  }

  function schedulePoll(jobId: string) {
    // Phase 25 carry-over: implement GET /submissions/:submissionId/export/:jobId
    // For now we stub the poll — after POLL_INTERVAL_MS we surface an informational message.
    pollTimerRef.current = setTimeout(() => {
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        setErrorMsg('PDF generation is taking longer than expected. Try again later.');
        setPollStatus('error');
        return;
      }
      // In a real implementation this would fetch the job status.
      // Stub: mark as timed out for Phase 24.
      setErrorMsg(
        `PDF export job ${jobId} enqueued. Server-side PDF rendering is Phase 25. Check back later.`,
      );
      setPollStatus('error');
    }, POLL_INTERVAL_MS);
  }

  const isGenerating = exportMutation.isPending || pollStatus === 'polling';

  return (
    <div className="container mx-auto py-8 px-4 max-w-lg" data-testid="export-panel">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Export Submission</h2>

      {/* Format selector */}
      <div className="mb-6">
        <p className="text-sm font-medium text-gray-700 mb-2">Format</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="export-format"
              value="markdown"
              checked={format === 'markdown'}
              onChange={() => setFormat('markdown')}
              data-testid="format-markdown"
            />
            <span className="text-sm text-gray-700">Markdown</span>
            <span className="text-xs text-gray-400">(instant download)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="export-format"
              value="pdf"
              checked={format === 'pdf'}
              onChange={() => setFormat('pdf')}
              data-testid="format-pdf"
            />
            <span className="text-sm text-gray-700">PDF</span>
            <span className="text-xs text-gray-400">(async generation)</span>
          </label>
        </div>
      </div>

      {/* Generate button */}
      <button
        onClick={() => void handleGenerate()}
        disabled={isGenerating || submissionId === ''}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        data-testid="generate-export-btn"
      >
        {isGenerating
          ? pollStatus === 'polling'
            ? 'Generating PDF…'
            : 'Generating…'
          : 'Generate Export'}
      </button>

      {/* Status messages */}
      {pollStatus === 'ready' && downloadUrl && (
        <div
          className="mt-4 p-3 bg-green-50 border border-green-200 rounded"
          data-testid="export-ready"
        >
          <p className="text-sm text-green-800 font-medium">Export ready!</p>
          <a
            href={downloadUrl}
            download
            className="text-xs text-green-700 underline"
            data-testid="export-download-link"
          >
            Download again
          </a>
        </div>
      )}

      {pollStatus === 'polling' && (
        <div
          className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded"
          data-testid="export-polling"
        >
          <p className="text-sm text-blue-800">PDF is being generated, please wait…</p>
        </div>
      )}

      {errorMsg && (
        <div
          className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded"
          data-testid="export-error"
        >
          <p className="text-sm text-yellow-800">{errorMsg}</p>
        </div>
      )}
    </div>
  );
}
