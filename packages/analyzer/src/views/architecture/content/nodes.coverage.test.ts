import { describe, it, expect } from 'vitest';
import { NODES, NO_DETAIL } from './nodes.js';
import { nodeKey } from './types.js';

/*
 * The committed diagrams are read through Vite rather than `node:fs`: the
 * analyzer package bans `node:*` imports (ESLint `no-restricted-imports`, to
 * keep every module browser-safe) and that rule covers test files too. This
 * also means the test consumes the assets exactly the way the route does.
 */
const RAW = import.meta.glob('../diagrams/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const DIAGRAMS: ReadonlyArray<readonly [string, string]> = Object.entries(RAW)
  .map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1), svg] as const)
  .sort(([a], [b]) => a.localeCompare(b));

/** Every `<g class="node"><title>NAME</title>` in a generated diagram. */
function nodeNames(svg: string): string[] {
  const out: string[] = [];
  const re = /<g id="[^"]*" class="node">\s*<title>([^<]+)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push(m[1]!);
  return out;
}

describe('architecture node coverage', () => {
  it('finds all 13 diagrams', () => {
    expect(DIAGRAMS).toHaveLength(13);
  });

  it.each(DIAGRAMS)('every node in %s has detail or is explicitly exempt', (file, svg) => {
    const diagram = file.replace(/\.svg$/, '');
    const missing = nodeNames(svg)
      .map((n) => nodeKey(diagram, n))
      .filter((k) => !(k in NODES) && !NO_DETAIL.has(k));
    expect(missing).toEqual([]);
  });

  it('has no metadata for nodes that no longer exist', () => {
    const live = new Set(
      DIAGRAMS.flatMap(([file, svg]) =>
        nodeNames(svg).map((n) => nodeKey(file.replace(/\.svg$/, ''), n)),
      ),
    );
    const orphans = [...Object.keys(NODES), ...NO_DETAIL].filter((k) => !live.has(k));
    expect(orphans).toEqual([]);
  });
});
