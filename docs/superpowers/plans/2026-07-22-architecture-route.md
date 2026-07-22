# Interactive `/architecture` Route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, interactive `/architecture` page in the analyzer that presents the 13 system diagrams with pan/zoom, per-node detail panels with source links, and its own light/dark theming.

**Architecture:** Graphviz `.dot` sources live in `tools/architecture/` and are compiled at dev time into **theme-agnostic** SVGs (semantic CSS classes instead of hardcoded hex), committed under `packages/analyzer/src/views/architecture/diagrams/`. The React route imports them with Vite's `?raw` and themes them entirely in CSS, scoped to a `[data-arch-theme]` wrapper so **nothing global is touched**. Node metadata is a plain TS record keyed by `diagramId:nodeName`; a test asserts every node in every committed SVG has either metadata or an explicit no-detail entry.

**Tech Stack:** React 18, React Router 6, Vite 5, Tailwind 3 (scoped tokens only), Radix Dialog (already a dependency), Vitest + Testing Library. Graphviz is a **dev-time-only system tool** — never required at build or runtime.

## Global Constraints

- **No new npm dependencies.** Pan/zoom is hand-rolled. Fullscreen uses `@radix-ui/react-dialog`, already in `package.json`.
- **Nothing global changes.** No edits to `tailwind.config.js`, `src/styles/globals.css`, `AppShell`, or `Header`. The only file outside `src/views/architecture/` that changes is `src/App.tsx` (one route).
- **Theming is scoped.** All architecture styles live under `[data-arch-theme="light"]` / `[data-arch-theme="dark"]`. No `.dark` class, no `prefers-color-scheme` outside that wrapper's default resolution.
- **The route is public** — no `RequireAuth`, no `RequireStaff`. It sits beside `/` (`LandingView`).
- **Generated SVGs are committed.** Graphviz must not be needed by `npm run build`, CI, or the server.
- **WCAG 2.1 AA** (compliance clock: April 2027). Keyboard-operable pan/zoom, focus management on the detail panel, contrast ≥ 4.5:1 for body text in **both** themes.
- TypeScript strict; no `any` except at documented FFI boundaries. Vitest tests co-located as `foo.test.tsx`.
- Commit style: conventional prefixes, `git commit --no-gpg-sign`, explicit pathspec, no Claude attribution.

---

## File Structure

**Created — tooling (dev-time only):**

- `tools/architecture/dot/*.dot` — 13 diagram sources, moved out of the gitignored `irb/architecture/dot/`.
- `tools/architecture/build-diagrams.py` — renders `.dot` → theme-agnostic SVG into the analyzer.
- `tools/architecture/README.md` — how to regenerate, and the graphviz prerequisite.

**Created — analyzer:**

- `src/views/architecture/diagrams/*.svg` — 13 generated, committed assets.
- `src/views/architecture/architecture.css` — scoped tokens + SVG semantic classes.
- `src/views/architecture/ArchitectureTheme.tsx` — scoped theme state + toggle.
- `src/views/architecture/DiagramCanvas.tsx` — pan/zoom + node click delegation.
- `src/views/architecture/DiagramFrame.tsx` — panel chrome (title, controls, fullscreen).
- `src/views/architecture/NodeDetailPanel.tsx` — selected-node detail.
- `src/views/architecture/Notation.tsx` — shape/colour/line key.
- `src/views/architecture/ArchitectureView.tsx` — route root: TOC, sections, layout.
- `src/views/architecture/content/types.ts` — `ArchNode`, `ArchSection`.
- `src/views/architecture/content/sections.ts` — the 13 sections + framing copy.
- `src/views/architecture/content/nodes.ts` — node metadata record.
- `src/views/architecture/content/nodes.coverage.test.ts` — the completeness invariant.

**Modified:**

- `src/App.tsx` — add one lazy public route.
- `CLAUDE.md` (repo root) — a standing requirement that the architecture page is updated alongside behaviour changes.

---

### Task 1: Move diagram sources into the repo and make the build emit theme-agnostic SVG

**Files:**

- Create: `tools/architecture/dot/` (13 files moved from `irb/architecture/dot/`)
- Create: `tools/architecture/build-diagrams.py`
- Create: `tools/architecture/README.md`
- Test: `tools/architecture/test_build_diagrams.py`

**Interfaces:**

- Produces: 13 SVGs at `packages/analyzer/src/views/architecture/diagrams/<name>.svg`, each with `class` attributes drawn from the token vocabulary below and **no** hardcoded colour attributes on themed elements.
- The token vocabulary later consumed by `architecture.css`:
  `f-rec f-fmt f-tra f-srv f-ana f-uix f-hum f-road f-bad f-panel f-canvas`
  `s-rec s-fmt s-tra s-srv s-ana s-uix s-hum s-road s-bad s-rule`
  `t-ink t-ink2 t-ink3` and per-band text `t-rec t-fmt t-tra t-srv t-ana t-uix t-hum t-road t-bad`.

- [ ] **Step 1: Move the sources**

```bash
mkdir -p tools/architecture/dot
cp /Users/aaryanmehta/projects/provenance/irb/architecture/dot/*.dot tools/architecture/dot/
ls tools/architecture/dot | wc -l   # expect 13
```

- [ ] **Step 2: Write the failing test**

Create `tools/architecture/test_build_diagrams.py`:

```python
"""Tests for the theme-agnostic SVG rewriter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_diagrams import themify  # noqa: E402


def test_fill_hex_becomes_a_semantic_class():
    src = '<polygon fill="#0d1c33" stroke="#4b90f7" points="0,0"/>'
    out = themify(src)
    assert 'fill="#0d1c33"' not in out
    assert 'stroke="#4b90f7"' not in out
    assert 'class="f-srv s-srv"' in out


def test_text_ink_becomes_a_text_class():
    src = '<text fill="#e8ecf4" x="1" y="2">hi</text>'
    out = themify(src)
    assert 'fill="#e8ecf4"' not in out
    assert 'class="t-ink"' in out


def test_existing_class_is_preserved_and_extended():
    src = '<g class="node"><polygon fill="#0d2416" stroke="#3fbf62"/></g>'
    out = themify(src)
    assert 'class="node"' in out
    assert 'class="f-ana s-ana"' in out


def test_transparent_and_none_are_left_alone():
    src = '<polygon fill="none" stroke="transparent"/>'
    out = themify(src)
    assert out == src


def test_unmapped_colour_raises_so_the_palette_cannot_drift():
    src = '<polygon fill="#123456"/>'
    try:
        themify(src)
    except ValueError as e:
        assert "#123456" in str(e)
    else:
        raise AssertionError("expected ValueError for an unmapped colour")
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd tools/architecture && python3 -m pytest test_build_diagrams.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'build_diagrams'`

- [ ] **Step 4: Write `build-diagrams.py`**

Create `tools/architecture/build_diagrams.py` (underscore so it is importable; a thin `build-diagrams.py` shim is not needed — call it with `python3 build_diagrams.py`):

```python
#!/usr/bin/env python3
"""
Compile the architecture .dot sources into THEME-AGNOSTIC SVG for the analyzer.

Graphviz bakes literal colours into its output. We rewrite every themed colour
attribute into a semantic class so a single committed asset can render in both
light and dark mode, themed entirely by architecture.css.

Graphviz is a DEV-TIME tool. Its output is committed; `npm run build`, CI and
the server never invoke it.

Usage:  python3 build_diagrams.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DOT = ROOT / "dot"
OUT = ROOT.parent.parent / "packages/analyzer/src/views/architecture/diagrams"

# Every colour the .dot sources may emit, mapped to its semantic token.
# A colour missing from here is a hard error — that is what keeps the palette
# from silently drifting as diagrams are edited.
FILL = {
    "#161b26": "f-panel", "#0b0d12": "f-canvas", "#12161f": "f-panel",
    "#241a0c": "f-rec",   "#1e1830": "f-fmt",    "#0e2422": "f-tra",
    "#0d1c33": "f-srv",   "#0d2416": "f-ana",    "#2a0f1e": "f-uix",
    "#191c22": "f-hum",   "#241f0c": "f-road",   "#2a1216": "f-bad",
    "#15171d": "f-hum",   "#1c1712": "f-rec",    "#1c1218": "f-uix",
    "#22201a": "f-hum",   "#12100c": "f-rec",    "#0e0b18": "f-fmt",
    "#0a1413": "f-tra",   "#0a0f18": "f-srv",    "#0a130d": "f-ana",
    "#150a10": "f-uix",   "#101319": "f-hum",    "#14120a": "f-road",
}
STROKE = {
    "#3a4457": "s-rule",  "#242b3b": "s-rule",  "#4a5568": "s-rule",
    "#F97316": "s-rec",   "#9d7bf5": "s-fmt",   "#17bfae": "s-tra",
    "#4b90f7": "s-srv",   "#3fbf62": "s-ana",   "#e8559c": "s-uix",
    "#8b95a8": "s-hum",   "#c9a227": "s-road",  "#ff6b6b": "s-bad",
    "#5d677d": "s-hum",   "#4a3316": "s-rec",   "#2e2450": "s-fmt",
    "#123c38": "s-tra",   "#16294a": "s-srv",   "#153c25": "s-ana",
    "#4a1b35": "s-uix",   "#333b4a": "s-hum",   "#5c4a12": "s-road",
}
TEXT = {
    "#e8ecf4": "t-ink",  "#98a2b6": "t-ink2", "#5d677d": "t-ink3",
    "#F97316": "t-rec",  "#9d7bf5": "t-fmt",  "#17bfae": "t-tra",
    "#4b90f7": "t-srv",  "#3fbf62": "t-ana",  "#e8559c": "t-uix",
    "#8b95a8": "t-hum",  "#c9a227": "t-road", "#ff6b6b": "t-bad",
}
KEEP = {"none", "transparent"}

_ATTR = re.compile(r'\s(fill|stroke)="([^"]+)"')
_TAG = re.compile(r"<(\w+)\b([^>]*)>")


def _lookup(table, value, kind):
    if value in KEEP:
        return None
    hit = table.get(value) or table.get(value.upper()) or table.get(value.lower())
    if hit is None:
        raise ValueError(
            f"unmapped {kind} colour {value!r} — add it to build_diagrams.py "
            f"and to architecture.css, or the diagram will not theme"
        )
    return hit


def themify(svg: str) -> str:
    """Replace themed fill/stroke attributes with semantic classes."""

    def rewrite(m):
        tag, attrs = m.group(1), m.group(2)
        classes = []
        keep = attrs

        for am in _ATTR.finditer(attrs):
            kind, value = am.group(1), am.group(2)
            if value in KEEP:
                continue
            table = TEXT if tag == "text" else (FILL if kind == "fill" else STROKE)
            cls = _lookup(table, value, kind)
            if cls:
                classes.append(cls)
                keep = keep.replace(am.group(0), "")

        if not classes:
            return m.group(0)

        existing = re.search(r'class="([^"]*)"', keep)
        if existing:
            keep = keep.replace(existing.group(0), f'class="{existing.group(1)}"')
            return f"<{tag}{keep} class=\"{' '.join(classes)}\">"
        return f"<{tag}{keep} class=\"{' '.join(classes)}\">"

    return _TAG.sub(rewrite, svg)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for src in sorted(DOT.glob("*.dot")):
        r = subprocess.run(["dot", "-Tsvg", str(src)], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"graphviz failed on {src.name}:\n{r.stderr}")
        svg = themify(r.stdout)
        svg = re.sub(r"<\?xml.*?\?>|<!DOCTYPE.*?>|<!--.*?-->", "", svg, flags=re.S)
        (OUT / f"{src.stem}.svg").write_text(svg.strip())
        print(f"  {src.stem}")
    print(f"wrote {len(list(DOT.glob('*.dot')))} diagrams to {OUT}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/architecture && python3 -m pytest test_build_diagrams.py -v`
Expected: 5 passed

- [ ] **Step 6: Generate the assets and eyeball one**

```bash
cd tools/architecture && python3 build_diagrams.py
grep -c 'class="' ../../packages/analyzer/src/views/architecture/diagrams/master.svg   # expect > 100
grep -c 'fill="#' ../../packages/analyzer/src/views/architecture/diagrams/master.svg   # expect 0
```

- [ ] **Step 7: Write the README**

Create `tools/architecture/README.md`:

````markdown
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
````

Output lands in `packages/analyzer/src/views/architecture/diagrams/`.

## Why the output has no colours in it

`build_diagrams.py` rewrites every themed `fill`/`stroke` into a semantic class
(`f-srv`, `s-ana`, `t-ink`, …) so one committed asset renders correctly in both
light and dark mode. The colours live in
`packages/analyzer/src/views/architecture/architecture.css`.

Adding a colour to a `.dot` file that is not in the `FILL`/`STROKE`/`TEXT` maps
is a hard build error. Add it to both the map and the stylesheet.

## Adding a node

Node metadata is keyed `"<diagram>:<node name>"` — the node name is the
identifier in the `.dot` file. After adding a node, add its entry to
`content/nodes.ts` or the coverage test will fail.

````

- [ ] **Step 8: Commit**

```bash
git add tools/architecture packages/analyzer/src/views/architecture/diagrams
git commit --no-gpg-sign -m "feat(analyzer): compile architecture diagrams to theme-agnostic SVG"
````

---

### Task 2: Scoped theme shell

**Files:**

- Create: `packages/analyzer/src/views/architecture/architecture.css`
- Create: `packages/analyzer/src/views/architecture/ArchitectureTheme.tsx`
- Test: `packages/analyzer/src/views/architecture/ArchitectureTheme.test.tsx`

**Interfaces:**

- Produces: `<ArchitectureTheme>{children}</ArchitectureTheme>` — renders a `div[data-arch-theme="light"|"dark"]`; `useArchTheme(): { theme, setTheme, resolved }` where `theme: 'light'|'dark'|'system'` and `resolved: 'light'|'dark'`. Persists to `localStorage['prov-arch-theme']`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArchitectureTheme, ArchThemeToggle, useArchTheme } from './ArchitectureTheme.js';

function Probe() {
  const { resolved } = useArchTheme();
  return <span data-testid="resolved">{resolved}</span>;
}

function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: prefersDark && q.includes('dark'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('ArchitectureTheme', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the OS preference', () => {
    mockMatchMedia(true);
    render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('scopes the theme to its own wrapper, never the document', () => {
    mockMatchMedia(true);
    const { container } = render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(container.querySelector('[data-arch-theme="dark"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggling persists the explicit choice', async () => {
    mockMatchMedia(false);
    render(
      <ArchitectureTheme>
        <ArchThemeToggle />
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    await userEvent.click(screen.getByRole('button', { name: /switch to dark/i }));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(localStorage.getItem('prov-arch-theme')).toBe('dark');
  });

  it('restores a persisted choice over the OS preference', () => {
    localStorage.setItem('prov-arch-theme', 'light');
    mockMatchMedia(true);
    render(
      <ArchitectureTheme>
        <Probe />
      </ArchitectureTheme>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- ArchitectureTheme`
Expected: FAIL — cannot resolve `./ArchitectureTheme.js`

- [ ] **Step 3: Implement the provider**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import './architecture.css';

export type ArchTheme = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const KEY = 'prov-arch-theme';

type Ctx = { theme: ArchTheme; resolved: Resolved; setTheme: (t: ArchTheme) => void };
const ArchThemeContext = createContext<Ctx | null>(null);

export function useArchTheme(): Ctx {
  const ctx = useContext(ArchThemeContext);
  if (!ctx) throw new Error('useArchTheme must be used inside <ArchitectureTheme>');
  return ctx;
}

function systemPref(): Resolved {
  if (typeof matchMedia !== 'function') return 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function stored(): ArchTheme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ArchitectureTheme({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ArchTheme>(stored);
  const [sys, setSys] = useState<Resolved>(systemPref);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSys(mq.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const setTheme = useCallback((t: ArchTheme) => {
    setThemeState(t);
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* private browsing — in-memory only */
    }
  }, []);

  const resolved: Resolved = theme === 'system' ? sys : theme;
  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return (
    <ArchThemeContext.Provider value={value}>
      <div data-arch-theme={resolved} className="arch-root">
        {children}
      </div>
    </ArchThemeContext.Provider>
  );
}

export function ArchThemeToggle() {
  const { resolved, setTheme } = useArchTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="arch-btn"
      aria-label={`Switch to ${next} mode`}
      onClick={() => setTheme(next)}
    >
      {resolved === 'dark' ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />}
      <span>{next}</span>
    </button>
  );
}
```

- [ ] **Step 4: Write `architecture.css`**

Both palettes plus the SVG token classes from Task 1. Dark values are the existing poster palette; light values are their AA-contrast counterparts.

```css
.arch-root {
  --arch-brand: #ea580c;
  --arch-rec: #c2410c;
  --arch-fmt: #6d28d9;
  --arch-tra: #0f766e;
  --arch-srv: #1d4ed8;
  --arch-ana: #15803d;
  --arch-uix: #be185d;
  --arch-hum: #475569;
  --arch-road: #a16207;
  --arch-bad: #b91c1c;
  --arch-bg: #ffffff;
  --arch-bg2: #f8fafc;
  --arch-panel: #ffffff;
  --arch-ink: #0f172a;
  --arch-ink2: #475569;
  --arch-ink3: #64748b;
  --arch-rule: #e2e8f0;
  --arch-tint: 8%;
  background: var(--arch-bg);
  color: var(--arch-ink);
}
.arch-root[data-arch-theme='dark'] {
  --arch-brand: #f97316;
  --arch-rec: #f97316;
  --arch-fmt: #9d7bf5;
  --arch-tra: #17bfae;
  --arch-srv: #4b90f7;
  --arch-ana: #3fbf62;
  --arch-uix: #e8559c;
  --arch-hum: #8b95a8;
  --arch-road: #c9a227;
  --arch-bad: #ff6b6b;
  --arch-bg: #0b0d12;
  --arch-bg2: #0f1219;
  --arch-panel: #141824;
  --arch-ink: #e8ecf4;
  --arch-ink2: #98a2b6;
  --arch-ink3: #5d677d;
  --arch-rule: #242b3b;
  --arch-tint: 14%;
}

/* SVG semantic classes — the vocabulary emitted by build_diagrams.py */
.arch-root svg .f-rec {
  fill: color-mix(in oklab, var(--arch-rec) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-fmt {
  fill: color-mix(in oklab, var(--arch-fmt) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-tra {
  fill: color-mix(in oklab, var(--arch-tra) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-srv {
  fill: color-mix(in oklab, var(--arch-srv) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-ana {
  fill: color-mix(in oklab, var(--arch-ana) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-uix {
  fill: color-mix(in oklab, var(--arch-uix) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-hum {
  fill: color-mix(in oklab, var(--arch-hum) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-road {
  fill: color-mix(in oklab, var(--arch-road) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-bad {
  fill: color-mix(in oklab, var(--arch-bad) var(--arch-tint), var(--arch-panel));
}
.arch-root svg .f-panel {
  fill: var(--arch-panel);
}
.arch-root svg .f-canvas {
  fill: var(--arch-bg);
}

.arch-root svg .s-rec {
  stroke: var(--arch-rec);
}
.arch-root svg .s-fmt {
  stroke: var(--arch-fmt);
}
.arch-root svg .s-tra {
  stroke: var(--arch-tra);
}
.arch-root svg .s-srv {
  stroke: var(--arch-srv);
}
.arch-root svg .s-ana {
  stroke: var(--arch-ana);
}
.arch-root svg .s-uix {
  stroke: var(--arch-uix);
}
.arch-root svg .s-hum {
  stroke: var(--arch-hum);
}
.arch-root svg .s-road {
  stroke: var(--arch-road);
}
.arch-root svg .s-bad {
  stroke: var(--arch-bad);
}
.arch-root svg .s-rule {
  stroke: var(--arch-rule);
}

.arch-root svg .t-ink {
  fill: var(--arch-ink);
}
.arch-root svg .t-ink2 {
  fill: var(--arch-ink2);
}
.arch-root svg .t-ink3 {
  fill: var(--arch-ink3);
}
.arch-root svg .t-rec {
  fill: var(--arch-rec);
}
.arch-root svg .t-fmt {
  fill: var(--arch-fmt);
}
.arch-root svg .t-tra {
  fill: var(--arch-tra);
}
.arch-root svg .t-srv {
  fill: var(--arch-srv);
}
.arch-root svg .t-ana {
  fill: var(--arch-ana);
}
.arch-root svg .t-uix {
  fill: var(--arch-uix);
}
.arch-root svg .t-hum {
  fill: var(--arch-hum);
}
.arch-root svg .t-road {
  fill: var(--arch-road);
}
.arch-root svg .t-bad {
  fill: var(--arch-bad);
}

/* interactive node affordance */
.arch-root svg g.node {
  cursor: pointer;
}
.arch-root svg g.node:hover [class*='s-'] {
  stroke-width: 2.4;
}
.arch-root svg g.node:focus-visible {
  outline: 2px solid var(--arch-brand);
  outline-offset: 2px;
}
.arch-root svg g.node[data-selected='true'] [class*='s-'] {
  stroke-width: 3;
}

.arch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--arch-rule);
  background: var(--arch-bg2);
  color: var(--arch-ink2);
  font:
    600 10px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  cursor: pointer;
}
.arch-btn:hover {
  color: var(--arch-ink);
}
.arch-btn[aria-pressed='true'] {
  background: var(--arch-brand);
  border-color: var(--arch-brand);
  color: #fff;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- ArchitectureTheme`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/architecture/ArchitectureTheme.tsx \
        packages/analyzer/src/views/architecture/ArchitectureTheme.test.tsx \
        packages/analyzer/src/views/architecture/architecture.css
git commit --no-gpg-sign -m "feat(analyzer): scoped light/dark theme for the architecture page"
```

---

### Task 3: Content model and the coverage invariant

**Files:**

- Create: `packages/analyzer/src/views/architecture/content/types.ts`
- Create: `packages/analyzer/src/views/architecture/content/nodes.ts`
- Test: `packages/analyzer/src/views/architecture/content/nodes.coverage.test.ts`

**Interfaces:**

- Produces: `type ArchNode = { title: string; body: string; invariant?: string; links?: ArchLink[] }`, `type ArchLink = { label: string; href: string }`, `const NODES: Record<string, ArchNode>`, `const NO_DETAIL: ReadonlySet<string>`, `nodeKey(diagram, name): string`.

- [ ] **Step 1: Write `types.ts`**

```ts
/** A deep link out of a node detail panel — source file, PRD section, or doc. */
export type ArchLink = { label: string; href: string };

/** Detail shown when a diagram node is selected. */
export type ArchNode = {
  /** Heading for the panel. Usually the node's label, spelled out. */
  title: string;
  /** Prose explanation. Plain text; rendered as paragraphs split on blank lines. */
  body: string;
  /** The load-bearing rule, if this node encodes one. Rendered as a callout. */
  invariant?: string;
  links?: ArchLink[];
};

/** Nodes are addressed as "<diagramId>:<dot node name>". */
export function nodeKey(diagram: string, name: string): string {
  return `${diagram}:${name}`;
}
```

- [ ] **Step 2: Write the failing coverage test**

This is the invariant that keeps content complete as diagrams change.

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NODES, NO_DETAIL } from './nodes.js';
import { nodeKey } from './types.js';

const DIR = join(__dirname, '..', 'diagrams');

/** Every `<g class="node"><title>NAME</title>` in a generated diagram. */
function nodeNames(svg: string): string[] {
  const out: string[] = [];
  const re = /<g id="[^"]*" class="node">\s*<title>([^<]+)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push(m[1]!);
  return out;
}

describe('architecture node coverage', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));

  it('finds all 13 diagrams', () => {
    expect(files).toHaveLength(13);
  });

  it.each(files)('every node in %s has detail or is explicitly exempt', (file) => {
    const diagram = file.replace(/\.svg$/, '');
    const svg = readFileSync(join(DIR, file), 'utf8');
    const missing = nodeNames(svg)
      .map((n) => nodeKey(diagram, n))
      .filter((k) => !(k in NODES) && !NO_DETAIL.has(k));
    expect(missing).toEqual([]);
  });

  it('has no metadata for nodes that no longer exist', () => {
    const live = new Set(
      files.flatMap((f) =>
        nodeNames(readFileSync(join(DIR, f), 'utf8')).map((n) =>
          nodeKey(f.replace(/\.svg$/, ''), n),
        ),
      ),
    );
    const orphans = [...Object.keys(NODES), ...NO_DETAIL].filter((k) => !live.has(k));
    expect(orphans).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- nodes.coverage`
Expected: FAIL — cannot resolve `./nodes.js`

- [ ] **Step 4: Author `nodes.ts`**

Start with the load-bearing nodes, then let the failing test enumerate the rest. Seed content:

```ts
import type { ArchNode } from './types.js';

const GH = 'https://github.com/ProvenanceTools/provenance/blob/main';

export const NODES: Record<string, ArchNode> = {
  'master:chain': {
    title: 'Hash chain',
    body: 'Every log entry is linked to its predecessor by a SHA-256 hash taken over the previous entry’s hash concatenated with the JCS-canonical form of this entry. Editing any entry after the fact breaks every link after it, and the break is locatable to an exact sequence number.\n\nThere is exactly one chaining function per language implementation, and every code path that produces a log entry goes through it. Two chaining paths would mean two behaviours, and therefore a seam to exploit.',
    invariant:
      'Exactly one chaining function. Every log-producing path goes through it — in all four repositories.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'Recorder PRD §5.2', href: `${GH}/docs/prd.md` },
    ],
  },
  'master:dedup': {
    title: 'Content-hash dedup',
    body: 'Before any heavy processing, ingest rejects a bundle whose (semester_id, blob_sha256) pair it has already seen. Because this check is cheap and happens first, re-sending an unchanged bundle costs almost nothing.\n\nThat property is what lets provgate treat its watermark as an optimisation rather than a correctness mechanism — if the watermark is wrong, dedup still prevents duplicate submissions.',
    invariant: 'Dedup runs before any heavy processing, never after.',
    links: [{ label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` }],
  },
  'master:strip': {
    title: 'Source stripping',
    body: 'After every in-memory computation that needs the student’s code — statistics, all eight validation checks, and the full heuristic pass — the server deletes the source files from the bundle and stores only the signed manifest and the logs.\n\nThis is the single largest cost lever in the system, and it is why storage on a 1 TB quota is viable at cohort scale.',
    invariant:
      'Stripping happens after all computation, and never touches manifest.json or manifest.sig — the stored bundle must stay signature- and chain-verifiable.',
    links: [
      {
        label: 'strip-bundle.ts',
        href: `${GH}/packages/server/src/services/ingest/strip-bundle.ts`,
      },
    ],
  },
  'recorder:expected': {
    title: 'Expected-content registry',
    body: 'The recorder maintains a model of what it believes every tracked file contains, updated after each edit it observes. External-change detection compares the on-disk hash against that model.\n\nThe direction matters and is easy to reverse: the model is the source of truth, the disk is what you check against it. Reversing it produces a recorder that flags every ordinary save and misses every real evasion.',
    invariant:
      'The expected-content model is the source of truth; the on-disk hash is compared to it.',
    links: [
      {
        label: 'expected-content.ts',
        href: `${GH}/packages/recorder/src/state/expected-content.ts`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },
  'provgate:adv': {
    title: 'Advance the watermark',
    body: 'The per-assignment watermark moves only after the Provenance ingest job reaches a terminal succeeded or partial state. On failure, or on any error mid-poll, it is left untouched so the next run retries.',
    invariant:
      'The watermark is an optimisation; content-hash dedup is correctness. When in doubt, forward.',
    links: [
      {
        label: 'engine.py',
        href: 'https://github.com/ProvenanceTools/provenance-gradescope-gateway/blob/main/src/provgate/sync/engine.py',
      },
    ],
  },
  'staff:hd': {
    title: 'Hosted-domain claim check',
    body: 'Authentication succeeds only when the Google ID token’s hd claim matches AUTH_ALLOWED_HOSTED_DOMAINS. It is the primary access control on the analyzer — the single check keeping non-institutional Google accounts out.',
    invariant: 'Do not loosen the hd check.',
    links: [{ label: 'auth', href: `${GH}/packages/server/src/auth` }],
  },
};

/**
 * Nodes that are self-explanatory labels and deliberately carry no panel
 * (actors, terminal states, purely decorative "…" spacers). Listing them
 * explicitly — rather than defaulting to "no detail" — is what makes the
 * coverage test meaningful.
 */
export const NO_DETAIL: ReadonlySet<string> = new Set<string>(['master:stu', 'chain:edots']);
```

- [ ] **Step 5: Run the test and let it enumerate the gap**

Run: `npm run test --workspace=packages/analyzer -- nodes.coverage`
Expected: FAIL, printing the exact missing keys per diagram. Work through them, adding either a `NODES` entry or a `NO_DETAIL` entry, until green. **Do not** widen the test to make it pass.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/architecture/content
git commit --no-gpg-sign -m "feat(analyzer): architecture node content model with coverage invariant"
```

---

### Task 4: Pan/zoom canvas with node selection

**Files:**

- Create: `packages/analyzer/src/views/architecture/DiagramCanvas.tsx`
- Test: `packages/analyzer/src/views/architecture/DiagramCanvas.test.tsx`

**Interfaces:**

- Consumes: nothing from earlier tasks except the CSS classes.
- Produces: `<DiagramCanvas svg={string} diagramId={string} selected={string|null} onSelect={(name: string | null) => void} />`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DiagramCanvas } from './DiagramCanvas.js';

const SVG = `<svg viewBox="0 0 100 100" width="100pt" height="100pt">
  <g id="node1" class="node"><title>dedup</title><polygon class="f-srv s-srv"/></g>
  <g id="node2" class="node"><title>strip</title><polygon class="f-rec s-rec"/></g>
</svg>`;

describe('DiagramCanvas', () => {
  it('selects the node whose title was clicked', () => {
    const onSelect = vi.fn();
    render(<DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('strip').closest('g')!);
    expect(onSelect).toHaveBeenCalledWith('strip');
  });

  it('marks the selected node for styling', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected="dedup" onSelect={vi.fn()} />,
    );
    const sel = container.querySelector('g.node[data-selected="true"]');
    expect(sel?.querySelector('title')?.textContent).toBe('dedup');
  });

  it('zooms in and resets', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={vi.fn()} />,
    );
    const stage = () => container.querySelector('.arch-stage') as HTMLElement;
    const before = stage().style.transform;
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(stage().style.transform).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: /reset view/i }));
    expect(stage().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('is keyboard operable', () => {
    const { container } = render(
      <DiagramCanvas svg={SVG} diagramId="master" selected={null} onSelect={vi.fn()} />,
    );
    const view = container.querySelector('.arch-viewport') as HTMLElement;
    view.focus();
    fireEvent.keyDown(view, { key: 'ArrowRight' });
    expect((container.querySelector('.arch-stage') as HTMLElement).style.transform).toContain(
      'translate(-40px, 0px)',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- DiagramCanvas`
Expected: FAIL — cannot resolve `./DiagramCanvas.js`

- [ ] **Step 3: Implement**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

type Props = {
  svg: string;
  diagramId: string;
  selected: string | null;
  onSelect: (name: string | null) => void;
};

const MIN = 0.2;
const MAX = 6;
const STEP = 40;

export function DiagramCanvas({ svg, diagramId, selected, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Reflect selection onto the injected markup (it lives outside React's tree).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.querySelectorAll('g.node').forEach((g) => {
      const name = g.querySelector('title')?.textContent ?? '';
      if (name === selected) g.setAttribute('data-selected', 'true');
      else g.removeAttribute('data-selected');
    });
  }, [selected, svg]);

  // Make nodes focusable so the diagram is keyboard-navigable.
  useEffect(() => {
    hostRef.current?.querySelectorAll('g.node').forEach((g) => {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      const name = g.querySelector('title')?.textContent ?? '';
      g.setAttribute('aria-label', `${name} — open details`);
    });
  }, [svg]);

  const pick = useCallback(
    (target: EventTarget | null) => {
      const g = (target as Element | null)?.closest?.('g.node');
      const name = g?.querySelector('title')?.textContent ?? null;
      onSelect(name);
    },
    [onSelect],
  );

  const zoomBy = useCallback((f: number) => {
    setT((p) => ({ ...p, k: Math.min(MAX, Math.max(MIN, p.k * f)) }));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return; // let the page scroll normally
    e.preventDefault();
    setT((p) => ({ ...p, k: Math.min(MAX, Math.max(MIN, p.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) }));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setT((p) => ({ ...p, x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const map: Record<string, [number, number]> = {
      ArrowRight: [-STEP, 0],
      ArrowLeft: [STEP, 0],
      ArrowDown: [0, -STEP],
      ArrowUp: [0, STEP],
    };
    const d = map[e.key];
    if (d) {
      e.preventDefault();
      setT((p) => ({ ...p, x: p.x + d[0], y: p.y + d[1] }));
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.2);
    }
    if (e.key === '-') {
      e.preventDefault();
      zoomBy(1 / 1.2);
    }
    if (e.key === '0') {
      e.preventDefault();
      setT({ x: 0, y: 0, k: 1 });
    }
    if (e.key === 'Escape') onSelect(null);
  };

  return (
    <div className="arch-canvas">
      <div className="arch-tools">
        <button type="button" className="arch-btn" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          <Plus size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="arch-btn"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <Minus size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="arch-btn"
          aria-label="Reset view"
          onClick={() => setT({ x: 0, y: 0, k: 1 })}
        >
          <RotateCcw size={13} aria-hidden />
        </button>
        <span className="arch-zoom">{Math.round(t.k * 100)}%</span>
      </div>
      <div
        className="arch-viewport"
        tabIndex={0}
        role="application"
        aria-label={`${diagramId} diagram — arrow keys pan, plus and minus zoom, 0 resets`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        onClick={(e) => pick(e.target)}
      >
        <div
          className="arch-stage"
          ref={hostRef}
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}
          /* Build-time authored asset, not user input. */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
```

Append to `architecture.css`:

```css
.arch-canvas {
  position: relative;
}
.arch-tools {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  gap: 6px;
  align-items: center;
}
.arch-zoom {
  font:
    600 10px/1 ui-monospace,
    Menlo,
    monospace;
  color: var(--arch-ink3);
  min-width: 38px;
  text-align: right;
}
.arch-viewport {
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  min-height: 320px;
  max-height: min(80vh, 1200px);
  background-image: radial-gradient(circle at 1px 1px, var(--arch-rule) 1px, transparent 0);
  background-size: 22px 22px;
}
.arch-viewport:active {
  cursor: grabbing;
}
.arch-viewport:focus-visible {
  outline: 2px solid var(--arch-brand);
  outline-offset: -2px;
}
.arch-stage {
  transform-origin: 0 0;
  will-change: transform;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- DiagramCanvas`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/architecture/DiagramCanvas.tsx \
        packages/analyzer/src/views/architecture/DiagramCanvas.test.tsx \
        packages/analyzer/src/views/architecture/architecture.css
git commit --no-gpg-sign -m "feat(analyzer): pan/zoom diagram canvas with node selection"
```

---

### Task 5: Node detail panel

**Files:**

- Create: `packages/analyzer/src/views/architecture/NodeDetailPanel.tsx`
- Test: `packages/analyzer/src/views/architecture/NodeDetailPanel.test.tsx`

**Interfaces:**

- Consumes: `NODES`, `nodeKey` from Task 3.
- Produces: `<NodeDetailPanel diagramId={string} node={string|null} onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { NodeDetailPanel } from './NodeDetailPanel.js';

describe('NodeDetailPanel', () => {
  it('renders nothing when no node is selected', () => {
    const { container } = render(
      <NodeDetailPanel diagramId="master" node={null} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders title, body, invariant and links for a known node', () => {
    render(<NodeDetailPanel diagramId="master" node="chain" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /hash chain/i })).toBeInTheDocument();
    expect(screen.getByText(/exactly one chaining function/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /hash-chain\.ts/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('packages/log-core'));
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('falls back gracefully for a node with no authored detail', () => {
    render(<NodeDetailPanel diagramId="master" node="stu" onClose={vi.fn()} />);
    expect(screen.getByText(/no additional detail/i)).toBeInTheDocument();
  });

  it('closes on the close button', async () => {
    const onClose = vi.fn();
    render(<NodeDetailPanel diagramId="master" node="chain" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- NodeDetailPanel`
Expected: FAIL — cannot resolve `./NodeDetailPanel.js`

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { NODES } from './content/nodes.js';
import { nodeKey } from './content/types.js';

type Props = { diagramId: string; node: string | null; onClose: () => void };

export function NodeDetailPanel({ diagramId, node, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (node) ref.current?.focus();
  }, [node]);

  if (!node) return null;
  const detail = NODES[nodeKey(diagramId, node)];

  return (
    <aside
      ref={ref}
      className="arch-detail"
      tabIndex={-1}
      role="region"
      aria-label="Node details"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="arch-detail-bar">
        <span className="arch-detail-eyebrow">{diagramId}</span>
        <button type="button" className="arch-btn" aria-label="Close details" onClick={onClose}>
          <X size={13} aria-hidden />
        </button>
      </div>

      {detail ? (
        <>
          <h3>{detail.title}</h3>
          {detail.body.split('\n\n').map((p) => (
            <p key={p.slice(0, 24)}>{p}</p>
          ))}
          {detail.invariant && (
            <div className="arch-invariant">
              <span>Invariant</span>
              <p>{detail.invariant}</p>
            </div>
          )}
          {detail.links && detail.links.length > 0 && (
            <ul className="arch-links">
              {detail.links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <h3>{node}</h3>
          <p className="arch-muted">
            No additional detail is authored for this node — its label is the whole story.
          </p>
        </>
      )}
    </aside>
  );
}
```

Append to `architecture.css`:

```css
.arch-detail {
  border: 1px solid var(--arch-rule);
  border-radius: 10px;
  background: var(--arch-panel);
  padding: 14px 16px;
}
.arch-detail:focus {
  outline: none;
}
.arch-detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.arch-detail-eyebrow {
  font:
    600 9.5px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.17em;
  text-transform: uppercase;
  color: var(--arch-ink3);
}
.arch-detail h3 {
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 8px;
  letter-spacing: -0.01em;
}
.arch-detail p {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--arch-ink2);
  margin: 0 0 10px;
}
.arch-muted {
  color: var(--arch-ink3);
  font-style: italic;
}
.arch-invariant {
  border-left: 3px solid var(--arch-brand);
  background: color-mix(in oklab, var(--arch-brand) 8%, transparent);
  border-radius: 0 7px 7px 0;
  padding: 9px 12px;
  margin: 0 0 10px;
}
.arch-invariant span {
  display: block;
  font:
    700 9px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--arch-brand);
  margin-bottom: 5px;
}
.arch-invariant p {
  margin: 0;
  color: var(--arch-ink);
}
.arch-links {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.arch-links a {
  display: inline-block;
  font:
    500 11.5px/1.5 ui-monospace,
    Menlo,
    monospace;
  color: var(--arch-brand);
  text-decoration: none;
  border: 1px solid color-mix(in oklab, var(--arch-brand) 35%, transparent);
  border-radius: 5px;
  padding: 2px 8px;
}
.arch-links a:hover {
  background: color-mix(in oklab, var(--arch-brand) 12%, transparent);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- NodeDetailPanel`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/architecture/NodeDetailPanel.tsx \
        packages/analyzer/src/views/architecture/NodeDetailPanel.test.tsx \
        packages/analyzer/src/views/architecture/architecture.css
git commit --no-gpg-sign -m "feat(analyzer): architecture node detail panel"
```

---

### Task 6: Diagram frame with fullscreen

**Files:**

- Create: `packages/analyzer/src/views/architecture/DiagramFrame.tsx`
- Test: `packages/analyzer/src/views/architecture/DiagramFrame.test.tsx`

**Interfaces:**

- Consumes: `DiagramCanvas` (Task 4), `NodeDetailPanel` (Task 5).
- Produces: `<DiagramFrame id={string} title={string} svg={string} />` — owns the selected-node state and the fullscreen dialog.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { DiagramFrame } from './DiagramFrame.js';

const SVG = `<svg viewBox="0 0 10 10" width="10pt" height="10pt">
  <g id="node1" class="node"><title>chain</title><polygon class="f-fmt s-fmt"/></g>
</svg>`;

describe('DiagramFrame', () => {
  it('shows the title and no panel until a node is picked', () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    expect(screen.getByText('End-to-end')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /node details/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel when a node is clicked', async () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    await userEvent.click(screen.getByText('chain').closest('g')!);
    expect(screen.getByRole('region', { name: /node details/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /hash chain/i })).toBeInTheDocument();
  });

  it('opens a fullscreen dialog', async () => {
    render(<DiagramFrame id="master" title="End-to-end" svg={SVG} />);
    await userEvent.click(screen.getByRole('button', { name: /full screen/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- DiagramFrame`
Expected: FAIL — cannot resolve `./DiagramFrame.js`

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import { DiagramCanvas } from './DiagramCanvas.js';
import { NodeDetailPanel } from './NodeDetailPanel.js';

type Props = { id: string; title: string; svg: string };

export function DiagramFrame({ id, title, svg }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  return (
    <figure className="arch-frame">
      <figcaption className="arch-frame-bar">
        <span className="arch-frame-title">{title}</span>
        <button
          type="button"
          className="arch-btn"
          aria-label="Full screen"
          onClick={() => setFull(true)}
        >
          <Maximize2 size={13} aria-hidden />
        </button>
      </figcaption>

      <div className="arch-frame-body">
        <DiagramCanvas svg={svg} diagramId={id} selected={sel} onSelect={setSel} />
        <NodeDetailPanel diagramId={id} node={sel} onClose={() => setSel(null)} />
      </div>

      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="max-w-[96vw] p-0">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div className="arch-root" data-arch-theme-inherit>
            <DiagramCanvas svg={svg} diagramId={id} selected={sel} onSelect={setSel} />
            <NodeDetailPanel diagramId={id} node={sel} onClose={() => setSel(null)} />
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}
```

Append to `architecture.css`:

```css
.arch-frame {
  margin: 0 0 26px;
  border: 1px solid var(--arch-rule);
  border-radius: 11px;
  background: var(--arch-bg2);
  overflow: hidden;
}
.arch-frame-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--arch-rule);
  background: var(--arch-panel);
}
.arch-frame-title {
  flex: 1;
  font:
    600 9.5px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.17em;
  text-transform: uppercase;
  color: var(--arch-ink2);
}
.arch-frame-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}
@media (min-width: 1180px) {
  .arch-frame-body:has(.arch-detail) {
    grid-template-columns: minmax(0, 1fr) 340px;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- DiagramFrame`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/architecture/DiagramFrame.tsx \
        packages/analyzer/src/views/architecture/DiagramFrame.test.tsx \
        packages/analyzer/src/views/architecture/architecture.css
git commit --no-gpg-sign -m "feat(analyzer): architecture diagram frame with fullscreen"
```

---

### Task 7: Sections content and the route

**Files:**

- Create: `packages/analyzer/src/views/architecture/content/sections.ts`
- Create: `packages/analyzer/src/views/architecture/Notation.tsx`
- Create: `packages/analyzer/src/views/architecture/ArchitectureView.tsx`
- Modify: `packages/analyzer/src/App.tsx`
- Test: `packages/analyzer/src/views/architecture/ArchitectureView.test.tsx`

**Interfaces:**

- Consumes: `DiagramFrame` (Task 6), `ArchitectureTheme` (Task 2).
- Produces: default-exported `ArchitectureView`; `SECTIONS: ArchSection[]` where `ArchSection = { id: string; num: string; title: string; framing: string; diagram: string; svg: string }` (`svg` is the raw markup, imported via `?raw`).
- Uses from `src/components/ui/dialog.tsx` (verified to exist): `Dialog`, `DialogContent`, `DialogTitle`.

- [ ] **Step 1: Write `sections.ts`**

Import each SVG with Vite's `?raw`, so the whole page is one lazily-loaded chunk.

```ts
import ecosystem from '../diagrams/ecosystem.svg?raw';
import master from '../diagrams/master.svg?raw';
import state from '../diagrams/state.svg?raw';
import recorder from '../diagrams/recorder.svg?raw';
import chain from '../diagrams/chain.svg?raw';
import ingest from '../diagrams/ingest.svg?raw';
import readpath from '../diagrams/readpath.svg?raw';
import er from '../diagrams/er.svg?raw';
import analysis from '../diagrams/analysis.svg?raw';
import staff from '../diagrams/staff.svg?raw';
import provgate from '../diagrams/provgate.svg?raw';
import deploy from '../diagrams/deploy.svg?raw';
import roadmap from '../diagrams/roadmap.svg?raw';

export type ArchSection = {
  id: string;
  num: string;
  title: string;
  framing: string;
  diagram: string;
  svg: string;
};

export const SECTIONS: ArchSection[] = [
  {
    id: 'ecosystem',
    num: '01',
    title: 'Repository & contract graph',
    diagram: 'ecosystem',
    svg: ecosystem,
    framing:
      'Four repositories. One owns the log format; the other three consume or reimplement it and are forbidden from changing it unilaterally. Conformance vectors are the enforcement mechanism — a sibling implementation must reproduce log-core’s test vectors byte for byte.',
  },
  {
    id: 'master',
    num: '02',
    title: 'End-to-end map',
    diagram: 'master',
    svg: master,
    framing:
      'The whole system as five swimlanes: the student’s offline machine, transport, the server, the analysis engine, and the staff reviewing the result. Every branch that exists in the code is drawn — including the paths where nothing is recorded, nothing is ingested, and nothing is done.',
  },
  {
    id: 'state',
    num: '03',
    title: 'Recorder state machine',
    diagram: 'state',
    svg: state,
    framing:
      'Three abnormal states had to be modelled explicitly, because each is otherwise indistinguishable from evasion.',
  },
  {
    id: 'recorder',
    num: '04',
    title: 'Recorder dataflow',
    diagram: 'recorder',
    svg: recorder,
    framing:
      'Host events in, hash-chained entries out. The top band is the only layer that differs between VS Code, IntelliJ and Neovim; everything below is shared logic reimplemented in three languages against the same vectors.',
  },
  {
    id: 'chain',
    num: '05',
    title: 'Format contract & cryptography',
    diagram: 'chain',
    svg: chain,
    framing:
      'Three keys with three distinct jobs, a chain linking every entry to its predecessor, and a verification path that still works years later against a bundle whose source files have been deleted.',
  },
  {
    id: 'ingest',
    num: '06',
    title: 'Ingest pipeline',
    diagram: 'ingest',
    svg: ingest,
    framing:
      'Four ordered stages with every rejection and failure path drawn. The pipeline is idempotent: a retry must produce byte-identical flags and stats, and tests assert it.',
  },
  {
    id: 'readpath',
    num: '07',
    title: 'Read path',
    diagram: 'readpath',
    svg: readpath,
    framing:
      'Cheap requests are answered from precomputed Postgres rows; anything needing the event stream re-parses the stored bundle, because there is no events table.',
  },
  {
    id: 'er',
    num: '08',
    title: 'Data model',
    diagram: 'er',
    svg: er,
    framing:
      'Twenty-one tables via Drizzle. The defining property is what is absent: no events table, and no student source in the stored blobs.',
  },
  {
    id: 'analysis',
    num: '09',
    title: 'Analysis engine',
    diagram: 'analysis',
    svg: analysis,
    framing:
      'A bundle goes in; a deterministic ranked flag list comes out. The same graph executes on the server during ingest and in the browser on the /local route.',
  },
  {
    id: 'staff',
    num: '10',
    title: 'Course-staff journey',
    diagram: 'staff',
    svg: staff,
    framing:
      'Staff work a ranked queue, not raw logs. The premise is 700 submissions and one afternoon, so the system’s job is to put the twelve that deserve a human at the top and justify each one.',
  },
  {
    id: 'provgate',
    num: '11',
    title: 'provgate — the Gradescope gateway',
    diagram: 'provgate',
    svg: provgate,
    framing:
      'A standalone Python service that keeps Provenance in sync with Gradescope on a schedule. It holds no Provenance code, database or storage — it authenticates like any third-party client.',
  },
  {
    id: 'deploy',
    num: '12',
    title: 'Deployment',
    diagram: 'deploy',
    svg: deploy,
    framing:
      'Running on the EECS Instructional apphost. There is no CI/CD — GitHub’s hosted runners cannot reach the host, so every step is run by hand against a documented runbook.',
  },
  {
    id: 'roadmap',
    num: '13',
    title: 'Roadmap',
    diagram: 'roadmap',
    svg: roadmap,
    framing:
      'Everything above is shipped and live. Below is not built — each item is drawn attached to the existing seam it would extend.',
  },
];
```

- [ ] **Step 2: Write the failing route test**

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import ArchitectureView from './ArchitectureView.js';

vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

describe('ArchitectureView', () => {
  it('renders all 13 sections with their diagrams', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /end-to-end map/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /roadmap/i })).toBeInTheDocument();
    expect(screen.getAllByRole('figure')).toHaveLength(13);
  });

  it('exposes a table of contents', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const toc = screen.getByRole('navigation', { name: /sections/i });
    expect(toc).toBeInTheDocument();
  });

  it('has a theme toggle and does not touch the document theme', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /switch to dark/i })).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- ArchitectureView`
Expected: FAIL — cannot resolve `./ArchitectureView.js`

- [ ] **Step 4: Implement `Notation.tsx` and `ArchitectureView.tsx`**

`Notation.tsx` renders the shape/colour/line key — three `.arch-kb` cards inside an
`.arch-key` grid:

1. **Shape — what it is.** Six rows, each an inline `<svg width="34" height="18">`
   drawing the graphviz shape in `stroke="var(--arch-hum)" fill="var(--arch-panel)"`:
   rounded rect (_process_), diamond (_decision_), cylinder (_datastore_), note /
   folded-corner rect (_artifact_), chevron-right (_queue_), hexagon (_external_).
2. **Colour — which concern.** Seven rows, each a `<span className="arch-sw"
style={{ background: 'var(--arch-rec)' }} />` — and likewise `--arch-fmt`,
   `--arch-tra`, `--arch-srv`, `--arch-ana`, `--arch-uix`, `--arch-hum` — labelled
   Producers / Format contract / Transport / Server / Analysis / Presentation &amp;
   keys / Humans &amp; externals.
3. **Line — which kind of path.** Five rows: solid, dashed, red dashed
   (`var(--arch-bad)`), gold dotted (`var(--arch-road)`), thick border.

Use CSS variables for every colour — no literal hex — so the key re-themes with the
diagrams. The prose for each row is in `irb/architecture/page.template.html` §00
and can be copied verbatim.

`ArchitectureView.tsx`:

```tsx
import { ArchitectureTheme, ArchThemeToggle } from './ArchitectureTheme.js';
import { DiagramFrame } from './DiagramFrame.js';
import { Notation } from './Notation.js';
import { SECTIONS } from './content/sections.js';

export default function ArchitectureView() {
  return (
    <ArchitectureTheme>
      <div className="arch-shell">
        <aside className="arch-toc">
          <div className="arch-brandmark">
            <svg width="22" height="22" viewBox="0 0 256 256" aria-hidden>
              <defs>
                <clipPath id="archmark">
                  <rect x="96" y="50" width="64" height="78" />
                </clipPath>
              </defs>
              <rect
                x="50"
                y="74"
                width="96"
                height="104"
                rx="34"
                fill="none"
                stroke="var(--arch-ink)"
                strokeWidth="18"
              />
              <rect
                x="110"
                y="74"
                width="96"
                height="104"
                rx="34"
                fill="none"
                stroke="var(--arch-brand)"
                strokeWidth="18"
              />
              <g clipPath="url(#archmark)">
                <rect
                  x="50"
                  y="74"
                  width="96"
                  height="104"
                  rx="34"
                  fill="none"
                  stroke="var(--arch-ink)"
                  strokeWidth="18"
                />
              </g>
            </svg>
            <h1>Provenance</h1>
          </div>
          <nav aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                <b>{s.num}</b>
                {s.title}
              </a>
            ))}
          </nav>
          <ArchThemeToggle />
        </aside>

        <main className="arch-main">
          <header className="arch-mast">
            <p className="arch-kick">Four repositories · Three recorders · One signed format</p>
            <h2>System architecture</h2>
            <p className="arch-deck">
              Provenance answers “how did this code come to exist?” rather than “does this code look
              copied?” — recording the process of authorship into a hash-chained, cryptographically
              signed log while a student works, then giving course staff a way to review thousands
              of those logs at scale.
            </p>
          </header>

          <Notation />

          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="arch-section">
              <div className="arch-section-hd">
                <span className="arch-num">{s.num}</span>
                <h3>{s.title}</h3>
              </div>
              <p className="arch-framing">{s.framing}</p>
              <DiagramFrame id={s.diagram} title={s.title} svg={s.svg} />
            </section>
          ))}
        </main>
      </div>
    </ArchitectureTheme>
  );
}
```

Append the layout rules to `architecture.css`:

```css
.arch-shell {
  display: grid;
  grid-template-columns: 242px minmax(0, 1fr);
  min-height: 100vh;
}
.arch-toc {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 24px 16px 60px;
  border-right: 1px solid var(--arch-rule);
  background: var(--arch-bg2);
}
.arch-brandmark {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}
.arch-brandmark h1 {
  margin: 0;
  font:
    700 13.5px/1.2 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.arch-toc nav a {
  display: block;
  padding: 5px 9px;
  border-left: 2px solid transparent;
  font-size: 12px;
  line-height: 1.4;
  color: var(--arch-ink2);
  text-decoration: none;
}
.arch-toc nav a:hover {
  color: var(--arch-ink);
  background: var(--arch-panel);
}
.arch-toc nav a b {
  font:
    600 9.5px/1 ui-monospace,
    Menlo,
    monospace;
  color: var(--arch-ink3);
  margin-right: 8px;
}
.arch-toc > .arch-btn {
  margin-top: 22px;
}
.arch-main {
  padding: 0 40px 140px;
  min-width: 0;
}
.arch-mast {
  padding: 58px 0 34px;
  border-bottom: 1px solid var(--arch-rule);
  margin-bottom: 8px;
}
.arch-kick {
  font:
    600 10.5px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--arch-brand);
  margin: 0 0 18px;
}
.arch-mast h2 {
  font-size: clamp(34px, 5vw, 56px);
  font-weight: 750;
  letter-spacing: -0.035em;
  margin: 0 0 16px;
}
.arch-deck {
  font-size: 18px;
  line-height: 1.55;
  color: var(--arch-ink2);
  max-width: 70ch;
  margin: 0;
}
.arch-section {
  padding: 52px 0 0;
  scroll-margin-top: 8px;
}
.arch-section-hd {
  display: flex;
  align-items: baseline;
  gap: 13px;
  margin-bottom: 12px;
}
.arch-num {
  flex: none;
  font:
    700 10.5px/1 ui-monospace,
    Menlo,
    monospace;
  letter-spacing: 0.1em;
  color: var(--arch-brand);
  padding: 5px 8px;
  border-radius: 5px;
  border: 1px solid color-mix(in oklab, var(--arch-brand) 45%, transparent);
  background: color-mix(in oklab, var(--arch-brand) 9%, transparent);
}
.arch-section-hd h3 {
  margin: 0;
  font-size: 25px;
  font-weight: 700;
  letter-spacing: -0.022em;
}
.arch-framing {
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--arch-ink2);
  max-width: 78ch;
  margin: 0 0 20px;
}
.arch-key {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(215px, 1fr));
  gap: 11px;
  margin: 0 0 20px;
}
.arch-kb {
  border: 1px solid var(--arch-rule);
  border-radius: 9px;
  padding: 12px 14px;
  background: var(--arch-panel);
}
.arch-sw {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex: none;
  display: inline-block;
}
@media (max-width: 960px) {
  .arch-shell {
    grid-template-columns: 1fr;
  }
  .arch-toc {
    position: static;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--arch-rule);
  }
  .arch-main {
    padding: 0 18px 90px;
  }
}
```

- [ ] **Step 5: Add the public route**

In `src/App.tsx`, beside the other lazy imports:

```tsx
const ArchitectureView = lazy(() => import('./views/architecture/ArchitectureView.js'));
```

And immediately before the `path="/"` landing route:

```tsx
{
  /* ── public architecture documentation ──────────────────────────── */
}
<Route path="/architecture" element={<ArchitectureView />} />;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- ArchitectureView`
Expected: 3 passed

- [ ] **Step 7: Verify the whole workspace still passes**

```bash
npm run build --workspace=packages/analyzer
npm run typecheck
npm run lint
npm run test --workspace=packages/analyzer
```

Expected: all green. Note the analyzer chunk report — the architecture chunk should be **separate** from the main bundle (it is lazy). If it is not, the `lazy()` import is wrong.

- [ ] **Step 8: Commit**

```bash
git add packages/analyzer/src/views/architecture packages/analyzer/src/App.tsx
git commit --no-gpg-sign -m "feat(analyzer): public interactive /architecture route"
```

---

### Task 8: Accessibility and cross-theme verification

**Files:**

- Test: `packages/analyzer/src/views/architecture/architecture.a11y.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import ArchitectureView from './ArchitectureView.js';

vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

describe('architecture accessibility', () => {
  it('gives every diagram viewport an accessible name', () => {
    render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const apps = screen.getAllByRole('application');
    expect(apps).toHaveLength(13);
    apps.forEach((a) => expect(a).toHaveAccessibleName());
  });

  it('makes diagram nodes reachable as buttons', () => {
    const { container } = render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const nodes = container.querySelectorAll('g.node[role="button"][tabindex="0"]');
    expect(nodes.length).toBeGreaterThan(50);
    nodes.forEach((n) => expect(n.getAttribute('aria-label')).toBeTruthy());
  });

  it('moves focus to the detail panel when a node is selected', async () => {
    const { container } = render(
      <MemoryRouter>
        <ArchitectureView />
      </MemoryRouter>,
    );
    const node = container.querySelector('g.node') as SVGGElement;
    await userEvent.click(node);
    expect(document.activeElement).toHaveAttribute('aria-label', 'Node details');
  });
});
```

- [ ] **Step 2: Run and fix until green**

Run: `npm run test --workspace=packages/analyzer -- architecture.a11y`
Expected: 3 passed.

- [ ] **Step 3: Manual cross-theme check (not automatable)**

```bash
npm run dev --workspace=packages/analyzer
# visit http://localhost:5173/architecture
```

Confirm by eye, in **both** themes:

1. No diagram renders with invisible text (a missed colour mapping shows as black-on-black or white-on-white).
2. Node hover and selection are visible in both.
3. The page is reachable while **signed out** — open a private window.
4. Zoom to 400% and confirm labels stay legible; reset with `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/analyzer/src/views/architecture/architecture.a11y.test.tsx
git commit --no-gpg-sign -m "test(analyzer): accessibility coverage for the architecture route"
```

---

### Task 9: Make keeping the page current a standing requirement

The page is only worth having if it stays true. Documentation that silently rots
is worse than none, because it is trusted. This task writes the obligation into
`CLAUDE.md`, which every agent reads before working in this repo.

**Files:**

- Modify: `CLAUDE.md` (repo root)

- [ ] **Step 1: Add the maintenance rule**

Insert a new subsection at the end of the **Working agreement** section, immediately
before `## Architecture rules`:

```markdown
- **Keep the architecture page current.** `/architecture` (source:
  `packages/analyzer/src/views/architecture/`, diagrams: `tools/architecture/dot/`)
  is the system's map of record. It is **not** optional documentation — a change
  that makes it wrong is an incomplete change. Update it in the **same PR** as
  the behaviour change whenever you:
  - add, remove, or rename an **event type**, validation check, or heuristic;
  - change the **ingest pipeline** stage order, dedup, stripping, or the read path;
  - change the **recorder**'s activation, signal capture, state machine, or failure
    handling — in _any_ of the three recorders;
  - change the **format contract**, key handling, checkpoint cadence, or bundle shape;
  - add or remove a **Postgres table**, or change what is persisted vs. re-parsed;
  - add, remove, or re-scope an **analyzer route**;
  - change **provgate**'s sync flow, or the deployment topology.

  How: edit the relevant `tools/architecture/dot/*.dot`, run
  `python3 tools/architecture/build_diagrams.py` (needs Graphviz — dev-time only),
  then update `content/nodes.ts` and `content/sections.ts`. The
  `nodes.coverage.test.ts` suite fails if a diagram gains a node with no detail,
  or keeps metadata for a node that no longer exists — so a stale page is a
  **failing test**, not a silent regression.

  If a change genuinely does not affect the page, say so explicitly in your summary
  rather than staying silent about it.
```

- [ ] **Step 2: Add a pointer in the repo-layout tree**

In the `## Repo layout` code block, under `packages/analyzer/`, and in the
top-level list, add:

```
├── tools/
│   └── architecture/    # Graphviz sources for the /architecture page (dev-time)
```

- [ ] **Step 3: Add the command**

In the `## Commands` section, under "Workspace-wide", add:

```markdown
- `python3 tools/architecture/build_diagrams.py` — regenerate the `/architecture`
  diagrams after editing `tools/architecture/dot/*.dot`. Requires Graphviz
  (`brew install graphviz`); dev-time only, never needed by `npm run build` or CI.
```

- [ ] **Step 4: Verify the rule is discoverable**

```bash
grep -n "architecture page current" CLAUDE.md
grep -n "build_diagrams" CLAUDE.md
```

Expected: both match.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit --no-gpg-sign -m "docs: require the architecture page to be updated with behaviour changes"
```

---

## Deferred, deliberately

- **App-wide dark mode.** 51 view files / 646 hardcoded colour utilities. Tracked separately; this route is self-contained and does not depend on it.
- **Staleness detection for generated SVGs.** Would require Graphviz in CI. The `nodes.coverage` test catches the failure mode that actually matters (a diagram changing without its content following).
- **The static `irb/architecture/` page and poster.** They remain the print/offline artifact; this route supersedes them for the web.
