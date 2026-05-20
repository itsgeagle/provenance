/**
 * LoadView — full-screen drop zone with file-picker fallback.
 *
 * Drag-and-drop uses native HTML5 events (no lib). The file picker is a
 * hidden <input type="file"> activated by the "Choose file" button.
 *
 * On status === 'loaded', navigates to /overview via useEffect so the
 * navigation is decoupled from the async load pipeline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import { LoadingPanel } from './LoadingPanel.js';
import { ErrorPanel } from './ErrorPanel.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';

export function LoadView() {
  const { status, loadingStage, loadError, loadBundleFiles, clearBundle } = useBundle();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Navigate to overview once a bundle is successfully loaded.
  useEffect(() => {
    if (status === 'loaded') {
      void navigate('/overview', { replace: true });
    }
  }, [status, navigate]);

  // ---------------------------------------------------------------------------
  // File handling — accepts one or more files
  // ---------------------------------------------------------------------------

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        void loadBundleFiles(files);
      }
    },
    [loadBundleFiles],
  );

  // ---------------------------------------------------------------------------
  // Drag-and-drop handlers (multi-file)
  // ---------------------------------------------------------------------------

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    },
    [handleFiles],
  );

  // ---------------------------------------------------------------------------
  // File picker handler (multi-file)
  // ---------------------------------------------------------------------------

  const onFilePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      handleFiles(files);
      // Reset the input so the same file can be re-selected after clearing.
      e.target.value = '';
    },
    [handleFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // ---------------------------------------------------------------------------
  // Retry: clear error state and allow a new drop.
  // ---------------------------------------------------------------------------

  const handleRetry = useCallback(() => {
    clearBundle();
  }, [clearBundle]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background">
        <LoadingPanel stage={loadingStage} />
      </div>
    );
  }

  if (status === 'error' && loadError !== null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
        <ErrorPanel error={loadError} onRetry={handleRetry} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Provenance Analyzer</h1>
          <p className="text-muted-foreground">
            Drop a submission bundle to inspect the recording.
          </p>
        </div>

        {/* Drop zone */}
        <Card
          data-testid="drop-zone"
          className={[
            'cursor-pointer border-2 border-dashed transition-colors',
            isDragOver
              ? 'border-primary bg-accent'
              : 'border-muted-foreground/30 hover:border-primary/60',
          ].join(' ')}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={openFilePicker}
          role="button"
          tabIndex={0}
          aria-label="Drop zone — click or drag .zip bundle(s) here"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openFilePicker();
          }}
        >
          <CardContent className="flex flex-col items-center gap-4 py-16">
            <svg
              aria-hidden="true"
              className="h-12 w-12 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <div className="text-center">
              <p className="text-base font-medium">Drop your .zip bundle(s) here</p>
              <p className="text-sm text-muted-foreground mt-1">
                or click to choose one or more files
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Hidden file input — multiple to support batch loading */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          multiple
          className="hidden"
          data-testid="file-input"
          onChange={onFilePickerChange}
          aria-label="Choose bundle file(s)"
        />

        <div className="flex justify-center">
          <Button variant="outline" onClick={openFilePicker} data-testid="choose-file-btn">
            Choose file
          </Button>
        </div>
      </div>
    </div>
  );
}
