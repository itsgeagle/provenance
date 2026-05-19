/**
 * download.ts — browser-side helper for triggering a file download.
 *
 * Kept tiny and DOM-only so the pure renderer in findings-markdown.ts can
 * stay framework-free and snapshot-tested without jsdom URL/anchor quirks.
 *
 * Usage:
 *   downloadAs('findings-hw1-20260519-123456.md', new Blob([md], { type: 'text/markdown' }));
 */

export function downloadAs(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // The element does not need to be in the DOM for `.click()` to work in
    // evergreen browsers, but jsdom and some browsers historically require
    // it. Append + remove keeps both happy.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke async so the click handler has time to start the download.
    // Synchronous revoke can race in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
