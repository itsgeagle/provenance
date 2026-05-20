#!/usr/bin/env node
/**
 * Update the analyzer's known-good extension-hash allowlist.
 *
 *   packages/analyzer/src/heuristics/config/known-good-extension-hashes.json
 *
 * The allowlist is consulted by the `extension_hash_mismatch` heuristic. Any
 * bundle whose `manifest.extension_hash` is NOT in the list gets flagged.
 *
 * USAGE
 *   node scripts/update-extension-hash-allowlist.mjs              # rebuild recorder, add its hash
 *   node scripts/update-extension-hash-allowlist.mjs --no-build   # use existing dist/, add its hash
 *   node scripts/update-extension-hash-allowlist.mjs --hash <hex> # add a specific hash
 *   node scripts/update-extension-hash-allowlist.mjs --remove <hex>
 *   node scripts/update-extension-hash-allowlist.mjs --clear      # remove all entries
 *   node scripts/update-extension-hash-allowlist.mjs --show
 *   node scripts/update-extension-hash-allowlist.mjs --help
 *
 * The placeholder sentinel
 *   "PLACEHOLDER_EXTENSION_HASH_REPLACE_BEFORE_DEPLOYMENT_..."
 * is stripped automatically the first time a real hash lands in the list.
 *
 * After every write, the script prints the resulting list with +/- markers.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(
  REPO_ROOT,
  'packages/analyzer/src/heuristics/config/known-good-extension-hashes.json',
);
const RECORDER_DIST = resolve(REPO_ROOT, 'packages/recorder/dist');
const PLACEHOLDER_PREFIX = 'PLACEHOLDER_EXTENSION_HASH';

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mode: 'add-from-dist', build: true, hash: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.mode = 'help';
    else if (a === '--show') opts.mode = 'show';
    else if (a === '--clear') opts.mode = 'clear';
    else if (a === '--no-build') opts.build = false;
    else if (a === '--hash') {
      opts.mode = 'add-literal';
      opts.hash = argv[++i];
    } else if (a === '--remove') {
      opts.mode = 'remove';
      opts.hash = argv[++i];
    } else {
      console.error(`Unknown argument: ${a}`);
      opts.mode = 'help';
      break;
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/update-extension-hash-allowlist.mjs [options]

Default action: rebuild packages/recorder/dist, compute its extension_hash,
and add it to the analyzer's known-good list (stripping the placeholder).

Options:
  --no-build         Use existing packages/recorder/dist (no rebuild).
  --hash <hex>       Add a specific 64-char lowercase hex hash (no dist read).
  --remove <hex>     Remove a specific hash from the allowlist.
  --clear            Remove all entries.
  --show             Print the current allowlist and exit.
  --help, -h         Show this help.

Allowlist file: ${ALLOWLIST_PATH}`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function readAllowlist() {
  const raw = await readFile(ALLOWLIST_PATH, 'utf8');
  const obj = JSON.parse(raw);
  if (!Array.isArray(obj.hashes)) {
    throw new Error(`Malformed allowlist: 'hashes' is not an array`);
  }
  return obj;
}

async function writeAllowlist(obj) {
  // Preserve top-level field order to keep the diff clean. We always write
  // $schema, $id, description, hashes (in that order) — match the existing file.
  const out = {
    $schema: obj.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: obj.$id ?? 'known-good-extension-hashes',
    description: obj.description,
    hashes: obj.hashes,
  };
  await writeFile(ALLOWLIST_PATH, JSON.stringify(out, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function isPlaceholder(s) {
  return typeof s === 'string' && s.startsWith(PLACEHOLDER_PREFIX);
}

function stripPlaceholders(hashes) {
  return hashes.filter((h) => !isPlaceholder(h));
}

function dedup(hashes) {
  return Array.from(new Set(hashes));
}

function validateHash(h) {
  if (!HEX64.test(h)) {
    throw new Error(`Invalid hash '${h}'. Expected 64-char lowercase hex (got ${h.length} chars).`);
  }
}

function rebuildRecorder() {
  console.log('Rebuilding packages/recorder/dist ...');
  const r = spawnSync('npm', ['run', 'build', '--workspace=packages/recorder'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`recorder build failed (exit ${r.status})`);
  }
}

async function computeHashFromDist() {
  // Import the recorder's own implementation so the algorithm matches exactly
  // what the recorder uses at seal time.
  const modPath = resolve(RECORDER_DIST, 'commands/extension-hash.js');
  let mod;
  try {
    mod = await import(modPath);
  } catch (err) {
    throw new Error(
      `Could not import ${modPath}. Has the recorder been built? ` +
        `(Run without --no-build, or run 'npm run build --workspace=packages/recorder'.)\n` +
        `Underlying error: ${err.message}`,
    );
  }
  return mod.computeExtensionHash(RECORDER_DIST);
}

function printList(label, hashes) {
  console.log(`${label}:`);
  if (hashes.length === 0) {
    console.log('  (empty)');
  } else {
    for (const h of hashes) {
      const tag = isPlaceholder(h) ? ' [placeholder]' : '';
      console.log(`  ${h}${tag}`);
    }
  }
}

function printDiff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((h) => !beforeSet.has(h));
  const removed = before.filter((h) => !afterSet.has(h));

  console.log('');
  console.log('Allowlist updated:');
  for (const h of removed) console.log(`  - ${h}${isPlaceholder(h) ? ' [placeholder]' : ''}`);
  for (const h of added) console.log(`  + ${h}`);
  if (added.length === 0 && removed.length === 0) {
    console.log('  (no changes)');
  }
  console.log('');
  printList('Current allowlist', after);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'help') {
    usage();
    return;
  }

  const obj = await readAllowlist();
  const before = [...obj.hashes];

  if (opts.mode === 'show') {
    printList('Current allowlist', before);
    return;
  }

  let next;

  if (opts.mode === 'clear') {
    next = [];
  } else if (opts.mode === 'add-literal') {
    if (!opts.hash) throw new Error('--hash requires a value');
    validateHash(opts.hash);
    next = dedup([...stripPlaceholders(before), opts.hash]);
  } else if (opts.mode === 'remove') {
    if (!opts.hash) throw new Error('--remove requires a value');
    next = before.filter((h) => h !== opts.hash);
  } else if (opts.mode === 'add-from-dist') {
    if (opts.build) rebuildRecorder();
    const hash = await computeHashFromDist();
    validateHash(hash);
    console.log(`Computed extension_hash from ${RECORDER_DIST}:\n  ${hash}`);
    next = dedup([...stripPlaceholders(before), hash]);
  } else {
    throw new Error(`Unknown mode: ${opts.mode}`);
  }

  obj.hashes = next;
  await writeAllowlist(obj);
  printDiff(before, next);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
