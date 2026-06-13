# Overview: list active third-party extensions (with AI flagging)

**Date:** 2026-06-12
**Status:** Approved design
**Affects:** `packages/analyzer` (both overview pages)

## Problem

The overview pages don't show which editor extensions were active during a session —
important context (especially AI coding assistants). The recorder already captures
this via `ext.snapshot` (all extensions with an `enabled`/`isActive` flag, emitted at
session start + every 5 min) and `ext.activate` (activation transitions).

## Behavior

Show an "Active extensions" card on the overview listing each **third-party**
extension that was active during the session:

- **Active set:** every extension seen with `enabled: true` across `ext.snapshot`
  events, unioned with any `ext.activate` ids. Dedup by id (keep the latest version
  seen).
- **Third-party only:** exclude VS Code built-ins — ids starting with `vscode.` or
  `ms-vscode.` and the other Microsoft-bundled publishers (`ms-vscode-remote.`).
- **AI flagging (display only):** badge extensions detected as AI assistants, with a
  short reason. This is for display — it does NOT change the scoring heuristic's
  `ai_extension_active` list (kept separate so flag/score behavior is unchanged).

## AI detection (thorough, id-based)

The recorder records only the extension `id` (`publisher.name`) and version — no
display name — so detection is id-based:

1. **Expanded curated id set** (superset of `heuristics/config/ai-extension-list.json`):
   Copilot / Copilot-Chat / Copilot-Labs, Cursor, Codeium, Windsurf, Continue,
   Tabnine, Sourcegraph Cody, Amazon Q / CodeWhisperer / AWS Toolkit, Blackbox,
   CodeGPT, Supermaven, Tabby, CodeGeeX, aiXcoder, AskCodi, Bito, Double, Mutable AI,
   IntelliCode, etc.
2. **Token patterns on the id** — tokenize on `.`/`-`/`_`, flag if any token matches
   an AI token: `copilot`, `codeium`, `cursor`, `tabnine`, `cody`, `codewhisperer`,
   `codegpt`, `blackbox`, `supermaven`, `aixcoder`, `codegeex`, `tabby`, `windsurf`,
   and standalone `ai` / `gpt` / `llm`. Token (not substring) matching prevents false
   positives on common extensions (`ms-python`, `esbenp.prettier-vscode`,
   `dbaeumer.vscode-eslint`, `ritwickdey.liveserver`, `christian-kohler.path-intellisense`).

Each AI hit carries a reason ("known AI extension" / "id contains 'copilot'") for the
badge tooltip.

## Pieces (`packages/analyzer/src/extensions/`)

- `detect-ai-extension.ts` — `detectAiExtension(id)` → `{ isAi: boolean; reason?: string }`.
  Curated set + token patterns.
- `collect-active-extensions.ts` — `collectActiveExtensions(snapshotEvents,
activateEvents)` → `ActiveExtension[]` = `{ id, version, isAi, aiReason? }`, deduped,
  third-party-only, sorted (AI first, then alphabetical). Takes plain event objects
  (`{ kind, payload }`) so it works for both providers.
- `ActiveExtensionsCard.tsx` — presentational card: `{ extensions: ActiveExtension[] }`.
  Lists id + version; AI ones get a red "AI" badge with reason tooltip. Empty state:
  "No third-party extensions were active."

## Wiring (both overviews)

- **v3 `views/submission/Overview.tsx`** (API-backed): `provider.useEvents({ kind:
['ext.snapshot','ext.activate'] })` → `collectActiveExtensions(...)` → card, added as
  a new section.
- **v2 `views/overview/OverviewView.tsx`** (`/local`): `index.byKind.get('ext.snapshot')`
  - `index.byKind.get('ext.activate')` → same helper → same card (as a Panel).

**Data-path risk to verify first:** the server `/events` response (`EventRow`) must
include the full `ext.snapshot` payload (the `extensions[]` array). If it returns a
summarized/truncated payload, the v3 path needs the full payload — confirm before
wiring, and fall back to extending the endpoint only if necessary.

## Non-goals

- No change to the recorder, the scoring heuristics, or `ai-extension-list.json`.
- No multi-cursor / per-snapshot timeline of extension changes (just the active set).

## Testing

- `detect-ai-extension`: curated hits, token-pattern hits, and a no-false-positives
  suite over common non-AI extension ids.
- `collect-active-extensions`: enabled filter, built-in exclusion, activate union,
  dedup + latest version, AI flag, sort order, empty input.
- `ActiveExtensionsCard`: renders list + AI badge; empty state.
