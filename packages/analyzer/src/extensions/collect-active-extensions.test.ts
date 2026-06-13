import { describe, it, expect } from 'vitest';
import { collectActiveExtensions, type EventLike } from './collect-active-extensions.js';

function snapshot(extensions: Array<{ id: string; version: string; enabled: boolean }>): EventLike {
  return { kind: 'ext.snapshot', payload: { extensions } };
}

function activate(id: string, version: string): EventLike {
  return { kind: 'ext.activate', payload: { id, version } };
}

describe('collectActiveExtensions', () => {
  it('returns an empty array for no events', () => {
    expect(collectActiveExtensions([], [])).toEqual([]);
  });

  it('includes only extensions with enabled: true', () => {
    const snap = snapshot([
      { id: 'esbenp.prettier-vscode', version: '1.0.0', enabled: true },
      { id: 'foo.disabled', version: '2.0.0', enabled: false },
    ]);
    const result = collectActiveExtensions([snap], []);
    expect(result.map((e) => e.id)).toEqual(['esbenp.prettier-vscode']);
  });

  it('excludes VS Code built-in publishers', () => {
    const snap = snapshot([
      { id: 'vscode.git', version: '1.0.0', enabled: true },
      { id: 'ms-vscode.cpptools', version: '1.0.0', enabled: true },
      { id: 'ms-vscode-remote.remote-ssh', version: '1.0.0', enabled: true },
      { id: 'esbenp.prettier-vscode', version: '1.0.0', enabled: true },
    ]);
    const result = collectActiveExtensions([snap], []);
    expect(result.map((e) => e.id)).toEqual(['esbenp.prettier-vscode']);
  });

  it('unions ext.activate ids with the snapshot set', () => {
    const snap = snapshot([{ id: 'esbenp.prettier-vscode', version: '1.0.0', enabled: true }]);
    const act = activate('GitHub.copilot', '1.150.0');
    const result = collectActiveExtensions([snap], [act]);
    expect(result.map((e) => e.id).sort()).toEqual(['GitHub.copilot', 'esbenp.prettier-vscode']);
  });

  it('dedups by id, keeping the latest version seen', () => {
    const first = snapshot([{ id: 'esbenp.prettier-vscode', version: '1.0.0', enabled: true }]);
    const second = snapshot([{ id: 'esbenp.prettier-vscode', version: '1.2.0', enabled: true }]);
    const result = collectActiveExtensions([first, second], []);
    expect(result).toHaveLength(1);
    expect(result[0]!.version).toBe('1.2.0');
  });

  it('flags AI extensions with a reason', () => {
    const snap = snapshot([{ id: 'GitHub.copilot', version: '1.0.0', enabled: true }]);
    const result = collectActiveExtensions([snap], []);
    expect(result[0]).toMatchObject({
      id: 'GitHub.copilot',
      isAi: true,
      aiReason: 'known AI extension',
    });
  });

  it('does not set aiReason for non-AI extensions', () => {
    const snap = snapshot([{ id: 'esbenp.prettier-vscode', version: '1.0.0', enabled: true }]);
    const result = collectActiveExtensions([snap], []);
    expect(result[0]!.isAi).toBe(false);
    expect(result[0]!.aiReason).toBeUndefined();
  });

  it('sorts AI extensions first, then alphabetically by id', () => {
    const snap = snapshot([
      { id: 'zeta.tool', version: '1.0.0', enabled: true },
      { id: 'alpha.tool', version: '1.0.0', enabled: true },
      { id: 'TabNine.tabnine-vscode', version: '1.0.0', enabled: true },
      { id: 'GitHub.copilot', version: '1.0.0', enabled: true },
    ]);
    const result = collectActiveExtensions([snap], []);
    expect(result.map((e) => e.id)).toEqual([
      'GitHub.copilot',
      'TabNine.tabnine-vscode',
      'alpha.tool',
      'zeta.tool',
    ]);
  });

  it('ignores malformed payloads defensively', () => {
    const events: EventLike[] = [
      { kind: 'ext.snapshot', payload: null },
      { kind: 'ext.snapshot', payload: {} },
      { kind: 'ext.snapshot', payload: { extensions: 'nope' } },
      { kind: 'ext.snapshot', payload: { extensions: [{ enabled: true }] } }, // no id
    ];
    expect(collectActiveExtensions(events, [{ kind: 'ext.activate', payload: null }])).toEqual([]);
  });
});
