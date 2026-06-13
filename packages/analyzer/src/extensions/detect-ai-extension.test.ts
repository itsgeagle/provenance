import { describe, it, expect } from 'vitest';
import { detectAiExtension } from './detect-ai-extension.js';

describe('detectAiExtension', () => {
  describe('curated id set', () => {
    const curated = [
      'GitHub.copilot',
      'GitHub.copilot-chat',
      'GitHub.copilot-labs',
      'anysphere.cursor-always-local',
      'Codeium.codeium',
      'anthropic.claude-code',
      'saoudrizwan.claude-dev',
      'rooveterinaryinc.roo-cline',
      'Continue.continue',
      'TabNine.tabnine-vscode',
      'TabNine.tabnine-enterprise',
      'sourcegraph.cody-ai',
      'AmazonWebServices.amazon-q-vscode',
      'AmazonWebServices.aws-toolkit-vscode',
      'Blackboxapp.blackbox',
      'DanielSanMedium.dscodegpt',
      'supermaven.supermaven',
      'TabbyML.vscode-tabby',
      'aminer.codegeex',
      'aixcoder.aixcoder',
      'AskCodi.askcodi',
      'Bito.bito',
      'double-bot.double-bot',
      'mutable-ai.mutable-ai',
      'VisualStudioExptTeam.vscodeintellicode',
    ];

    for (const id of curated) {
      it(`flags curated id ${id}`, () => {
        const result = detectAiExtension(id);
        expect(result.isAi).toBe(true);
        expect(result.reason).toBeTruthy();
      });
    }

    it('matches curated ids case-insensitively', () => {
      expect(detectAiExtension('github.COPILOT').isAi).toBe(true);
    });

    it('reports the AWS Toolkit (no AI token in id) as a known AI extension', () => {
      const result = detectAiExtension('AmazonWebServices.aws-toolkit-vscode');
      expect(result.isAi).toBe(true);
      expect(result.reason).toBe('known AI extension');
    });

    it('reports CodeGPT (token does not match) as a known AI extension', () => {
      // tokens are danielsanmedium / dscodegpt — neither equals the 'codegpt' token,
      // so this must be caught by the curated set, not token matching.
      const result = detectAiExtension('DanielSanMedium.dscodegpt');
      expect(result.isAi).toBe(true);
      expect(result.reason).toBe('known AI extension');
    });
  });

  describe('token-pattern matching', () => {
    const tokenCases: Array<[string, string]> = [
      ['SomePublisher.copilot-helper', 'copilot'],
      ['someorg.claude-companion', 'claude'],
      ['acme.codeium-plus', 'codeium'],
      ['x.my-cursor-thing', 'cursor'],
      ['x.tabnine-extras', 'tabnine'],
      ['x.cody-tools', 'cody'],
      ['x.codewhisperer-extra', 'codewhisperer'],
      ['x.codegpt-extra', 'codegpt'],
      ['x.blackbox-thing', 'blackbox'],
      ['x.supermaven-extra', 'supermaven'],
      ['x.aixcoder-extra', 'aixcoder'],
      ['x.codegeex-extra', 'codegeex'],
      ['x.tabby-extra', 'tabby'],
      ['x.windsurf-extra', 'windsurf'],
      ['some.ai-assistant', 'ai'],
      ['some.gpt-buddy', 'gpt'],
      ['some.llm-helper', 'llm'],
    ];

    for (const [id, token] of tokenCases) {
      it(`flags ${id} via token '${token}'`, () => {
        const result = detectAiExtension(id);
        expect(result.isAi).toBe(true);
        expect(result.reason).toBe(`id contains '${token}'`);
      });
    }

    it('tokenizes on dots, dashes, and underscores', () => {
      expect(detectAiExtension('pub.foo_ai_bar').isAi).toBe(true);
    });
  });

  describe('no false positives on common non-AI extensions', () => {
    const nonAi = [
      'ms-python.python',
      'esbenp.prettier-vscode',
      'dbaeumer.vscode-eslint',
      'ritwickdey.liveserver',
      'christian-kohler.path-intellisense',
      'bradlc.vscode-tailwindcss', // 'tailwindcss' contains the substring 'ai'
      'eamodio.gitlens',
      'redhat.vscode-yaml',
      'streetsidesoftware.code-spell-checker',
      'formulahendry.auto-rename-tag',
      'pkief.material-icon-theme',
    ];

    for (const id of nonAi) {
      it(`does not flag ${id}`, () => {
        const result = detectAiExtension(id);
        expect(result.isAi).toBe(false);
        expect(result.reason).toBeUndefined();
      });
    }
  });
});
