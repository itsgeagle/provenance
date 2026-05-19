/**
 * Non-dismissible status bar item indicating that recording is active.
 * PRD §4.1: "shows a non-dismissible status bar item ('CS 61A: recording')
 * so the student is always aware that telemetry is active."
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and show the "CS 61A: recording" status bar item.
 * The item is pushed onto the disposables list so it's cleaned up on deactivate.
 *
 * @param disposables  List to push the StatusBarItem onto.
 */
export function createRecordingStatusBar(disposables: vscode.Disposable[]): vscode.StatusBarItem {
  // Priority 100 keeps it visible at the left side, ahead of most extensions.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = '$(record) CS 61A: recording';
  item.tooltip = 'Provenance recorder is active for this CS 61A assignment.';
  item.show();

  disposables.push(item);
  return item;
}
