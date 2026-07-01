/**
 * AI coding-assistant detection by extension id.
 *
 * The recorder records only the extension `id` (`publisher.name`) and version —
 * no display name (recorder PRD §4.6) — so detection is id-based: a curated set
 * of known ids plus token-pattern matching on the id.
 *
 * Display-only. This deliberately does NOT feed the `ai_extension_active`
 * scoring heuristic, which has its own course-maintained list
 * (`heuristics/config/ai-extension-list.json`). Keeping the two separate means
 * flag/score behavior is unchanged by this display feature.
 */

export type AiDetection = {
  isAi: boolean;
  /** Human-readable reason for the badge tooltip; present only when isAi. */
  reason?: string;
};

/**
 * Curated set of known AI-assistant extension ids (lowercased), a superset of
 * `ai-extension-list.json`. Covers ids that token matching alone would miss
 * (e.g. `aws-toolkit-vscode`, `dscodegpt`, `vscodeintellicode`).
 */
const CURATED_AI_IDS = new Set<string>([
  // GitHub Copilot family
  'github.copilot',
  'github.copilot-chat',
  'github.copilot-labs',
  // Cursor
  'anysphere.cursor-always-local',
  // Codeium / Windsurf
  'codeium.codeium',
  'codeium.codeium-enterprise-updater',
  'codeium.windsurf',
  'exafunction.windsurf',
  // Anthropic Claude Code
  'anthropic.claude-code',
  // Cline (formerly "Claude Dev")
  'saoudrizwan.claude-dev',
  // Roo Code (Cline fork)
  'rooveterinaryinc.roo-cline',
  // Continue
  'continue.continue',
  // Tabnine
  'tabnine.tabnine-vscode',
  'tabnine.tabnine-enterprise',
  // Sourcegraph Cody
  'sourcegraph.cody-ai',
  // Amazon Q / CodeWhisperer / AWS Toolkit
  'amazonwebservices.amazon-q-vscode',
  'amazonwebservices.aws-toolkit-vscode',
  // Blackbox
  'blackboxapp.blackbox',
  'blackboxapp.blackboxagent',
  // CodeGPT
  'danielsanmedium.dscodegpt',
  // Supermaven
  'supermaven.supermaven',
  // Tabby
  'tabbyml.vscode-tabby',
  // CodeGeeX
  'aminer.codegeex',
  // aiXcoder
  'aixcoder.aixcoder',
  // AskCodi
  'askcodi.askcodi',
  // Bito
  'bito.bito',
  // Double
  'double-bot.double-bot',
  // Mutable AI
  'mutable-ai.mutable-ai',
  // IntelliCode
  'visualstudioexptteam.vscodeintellicode',
]);

/**
 * Tokens that, when they appear as a whole token in an id, indicate an AI tool.
 * Token (not substring) matching avoids false positives on ids like
 * `bradlc.vscode-tailwindcss` (substring 'ai' inside 'tailwindcss').
 */
const AI_TOKENS = new Set<string>([
  'copilot',
  'claude',
  'codeium',
  'cursor',
  'tabnine',
  'cody',
  'codewhisperer',
  'codegpt',
  'blackbox',
  'supermaven',
  'aixcoder',
  'codegeex',
  'tabby',
  'windsurf',
  'ai',
  'gpt',
  'llm',
]);

/** Split an id into lowercase tokens on `.`, `-`, and `_`. */
function tokenize(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[.\-_]/)
    .filter((t) => t.length > 0);
}

/**
 * Classify an extension id as an AI assistant (or not). Curated ids win first
 * (reason "known AI extension"); otherwise token matching (reason
 * "id contains '<token>'").
 */
export function detectAiExtension(id: string): AiDetection {
  if (CURATED_AI_IDS.has(id.toLowerCase())) {
    return { isAi: true, reason: 'known AI extension' };
  }
  for (const token of tokenize(id)) {
    if (AI_TOKENS.has(token)) {
      return { isAi: true, reason: `id contains '${token}'` };
    }
  }
  return { isAi: false };
}
