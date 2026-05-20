/**
 * FileTabs — one tab per file under review in the replay view.
 *
 * Clicking a tab calls onFileChange(filePath), which switches the Monaco model
 * in the parent ReplayView.
 *
 * Displays only the filename (basename) to keep tabs short; full path is shown
 * in the aria-label for accessibility.
 */

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.js';

type FileTabsProps = {
  /** Ordered list of files under review (from engine.files). */
  files: string[];
  /** Currently selected file path. */
  activeFile: string | null;
  /** Called when the user clicks a tab. */
  onFileChange(filePath: string): void;
};

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function FileTabs({ files, activeFile, onFileChange }: FileTabsProps) {
  if (files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-2 py-1" data-testid="file-tabs-empty">
        No files
      </div>
    );
  }

  return (
    <Tabs value={activeFile ?? files[0] ?? ''} onValueChange={onFileChange} data-testid="file-tabs">
      <TabsList className="h-auto flex-wrap gap-1 bg-transparent p-0">
        {files.map((filePath) => (
          <TabsTrigger
            key={filePath}
            value={filePath}
            aria-label={filePath}
            className="text-xs px-2 py-1 h-7"
          >
            {basename(filePath)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
