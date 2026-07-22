# Architecture diagram sources

The 13 diagrams on the analyzer's `/architecture` page are generated from the
Graphviz sources in `dot/`.

## Regenerating

Requires Graphviz (`brew install graphviz`). It is a **dev-time tool only** —
the generated SVGs are committed, and `npm run build`, CI and the server never
invoke it.

```sh
python3 tools/architecture/build_diagrams.py
```

Output lands in `packages/analyzer/src/views/architecture/diagrams/`.

## Why the output has no colours in it

`build_diagrams.py` rewrites every themed `fill`/`stroke` into a semantic class
(`f-srv`, `s-ana`, `t-ink`, …) so one committed asset renders correctly in both
light and dark mode. The colours live in
`packages/analyzer/src/views/architecture/architecture.css`.

Adding a colour to a `.dot` file that is not in the `FILL`/`STROKE`/`TEXT` maps
is a hard build error. Add it to both the map and the stylesheet.

### The token vocabulary

| Family                | Job                           | Example                     |
| --------------------- | ----------------------------- | --------------------------- |
| `f-*`                 | tinted node/cluster bodies    | `f-srv`, `f-ana`, `f-road`  |
| `f-panel`, `f-canvas` | flat surfaces                 | —                           |
| `a-*`                 | arrowheads — **solid** accent | `a-srv`, `a-edge`           |
| `s-*`                 | strokes (node borders, edges) | `s-srv`, `s-edge`, `s-rule` |
| `t-*`                 | text                          | `t-ink`, `t-ink2`, `t-srv`  |

Graphviz uses `fill` for three different jobs, which is why `f-*` and `a-*` are
separate families: a node body is the accent _tinted into_ the panel colour,
while an arrowhead is the accent at full strength. An arrowhead filled with a
tinted `f-*` disappears against the page.

`s-edge` is likewise distinct from `s-rule`: `s-edge` is the connector colour
between nodes and must stay legible on the canvas, whereas `s-rule` is the
deliberately faint colour used for panel borders in the surrounding chrome.

## Adding a node

Node metadata is keyed `"<diagram>:<node name>"` — the node name is the
identifier in the `.dot` file. After adding a node, add its entry to
`content/nodes.ts` or the coverage test will fail.
