import { describe, it, expect, vi } from 'vitest';
import type { ActiveSession } from '../session/session-registry.js';
import { buildSealQuickPickItems, chooseSessionForSeal } from './seal-selector.js';
import type { SealQuickPickItem } from './seal-selector.js';

function fakeSession(root: string, assignmentId: string): ActiveSession {
  return {
    assignmentRoot: root,
    manifest: {
      assignment_id: assignmentId,
      semester: 'fa26',
      issued_at: '',
      files_under_review: [],
      sig: '',
    },
  } as unknown as ActiveSession;
}

describe('buildSealQuickPickItems', () => {
  it('labels each item by assignment_id and describes it by folder', () => {
    const items = buildSealQuickPickItems([
      fakeSession('/ws/cats', 'cats'),
      fakeSession('/ws/hog', 'hog'),
    ]);
    expect(items).toEqual([
      {
        label: 'cats',
        description: '/ws/cats',
        session: expect.objectContaining({ assignmentRoot: '/ws/cats' }),
      },
      {
        label: 'hog',
        description: '/ws/hog',
        session: expect.objectContaining({ assignmentRoot: '/ws/hog' }),
      },
    ]);
  });
});

describe('chooseSessionForSeal', () => {
  it('returns the single session directly without prompting when only one is active', async () => {
    const showQuickPick = vi.fn();
    const only = fakeSession('/ws/hw03', 'hw03');
    const chosen = await chooseSessionForSeal([only], showQuickPick);
    expect(chosen).toBe(only);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('returns undefined and does not prompt when there are no sessions', async () => {
    const showQuickPick = vi.fn();
    const chosen = await chooseSessionForSeal([], showQuickPick);
    expect(chosen).toBeUndefined();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('prompts via QuickPick when more than one session is active, returns the chosen one', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    const showQuickPick = vi.fn(async (items: SealQuickPickItem[]) =>
      items.find((i) => i.session === hog),
    );
    const chosen = await chooseSessionForSeal([cats, hog], showQuickPick);
    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(chosen).toBe(hog);
  });

  it('returns undefined when the user dismisses the QuickPick', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    const showQuickPick = vi.fn(async () => undefined);
    const chosen = await chooseSessionForSeal([cats, hog], showQuickPick);
    expect(chosen).toBeUndefined();
  });

  it('defaults the pick to the session owning the active editor when provided', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    let placeHolderSeen = '';
    const showQuickPick = vi.fn(
      async (items: SealQuickPickItem[], opts: { placeHolder: string }) => {
        placeHolderSeen = opts.placeHolder;
        return items[0];
      },
    );
    await chooseSessionForSeal([cats, hog], showQuickPick, '/ws/hog/y.py');
    // The active-editor's owning session (hog) should be sorted first so it's the default highlight.
    const itemsPassed = showQuickPick.mock.calls[0]?.[0] as { session: ActiveSession }[];
    expect(itemsPassed[0]?.session).toBe(hog);
    expect(placeHolderSeen).toContain('assignment');
  });
});
