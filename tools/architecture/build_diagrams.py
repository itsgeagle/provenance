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
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DOT = ROOT / "dot"
OUT = ROOT.parent.parent / "packages/analyzer/src/views/architecture/diagrams"

# Graph-level overrides applied to every diagram at render time, tuned in one
# place rather than across 13 .dot files:
#   ranksep/nodesep — generous separation so edge labels sit clear of their
#                     arrows and neighbouring nodes never touch
#   sep=+18         — an extra 18pt margin around every node for overlap removal
#   esep           — keeps edges from grazing node borders
#   Nmargin        — interior padding so label text is not flush to the box edge
SPACING = [
    "-Granksep=1.05",
    "-Gnodesep=0.6",
    "-Gsep=+18",
    "-Gesep=+8",
    "-Gpad=0.3",
    "-Nmargin=0.18,0.09",
]

# Canvas layout: plates are packed into columns in this reading order, matching
# the poster. The app reads diagrams/layout.json for plate positions.
PLATE_ORDER = [
    "master", "ecosystem", "state", "recorder", "chain", "ingest",
    "readpath", "er", "analysis", "staff", "provgate", "deploy", "roadmap",
]
NCOLS = 4
GUTTER = 220  # canvas units between plates
TITLEBLOCK = 108  # header height reserved above each diagram

# Every colour the .dot sources may emit, mapped to its semantic token.
# A colour missing from here is a hard error — that is what keeps the palette
# from silently drifting as diagrams are edited.
#
# Three fill families, because graphviz uses `fill` for three different jobs:
#   f-*  tinted node/cluster bodies  — accent mixed into the panel colour
#   a-*  arrowheads                  — SOLID accent, matching the edge stroke
#   f-panel / f-canvas               — flat surfaces
# An arrowhead filled with a tinted `f-*` would vanish against the page, so the
# two must not share a token.
FILL = {
    # flat surfaces
    "#161b26": "f-panel", "#0b0d12": "f-canvas", "#12161f": "f-panel",
    # tinted node / cluster bodies
    "#241a0c": "f-rec",   "#1e1830": "f-fmt",    "#0e2422": "f-tra",
    "#0d1c33": "f-srv",   "#0d2416": "f-ana",    "#2a0f1e": "f-uix",
    "#191c22": "f-hum",   "#241f0c": "f-road",   "#2a1216": "f-bad",
    "#15171d": "f-hum",   "#1c1712": "f-rec",    "#1c1218": "f-uix",
    "#22201a": "f-hum",   "#12100c": "f-rec",    "#0e0b18": "f-fmt",
    "#0a1413": "f-tra",   "#0a0f18": "f-srv",    "#0a130d": "f-ana",
    "#150a10": "f-uix",   "#101319": "f-hum",    "#14120a": "f-road",
    # arrowheads — solid, and always the colour of the edge they terminate
    "#4a5568": "a-edge",  "#f97316": "a-rec",    "#9d7bf5": "a-fmt",
    "#17bfae": "a-tra",   "#4b90f7": "a-srv",    "#3fbf62": "a-ana",
    "#e8559c": "a-uix",   "#c9a227": "a-road",   "#ff6b6b": "a-bad",
    "#8b95a8": "a-hum",   "#5d677d": "a-hum",
}
STROKE = {
    # `#4a5568` is graphviz's default EDGE colour here, not a panel border —
    # it must stay legible on the canvas, so it gets its own token rather than
    # sharing the (deliberately faint) rule colour.
    "#4a5568": "s-edge",
    "#3a4457": "s-rule",  "#242b3b": "s-rule",
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
# Attributes are non-greedy and the trailing "/" of a self-closing tag is
# captured separately, so the rewritten tag keeps its original form. Getting
# this wrong emits `<path d="…"/ class="f-rec">`, which is not valid XML.
_TAG = re.compile(r"<(\w+)\b([^>]*?)(/?)>")
_CLASS = re.compile(r'\s?class="([^"]*)"')


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
        tag, attrs, close = m.group(1), m.group(2), m.group(3)
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

        # Merge into any class the element already carries — two class
        # attributes on one element is not valid XML.
        existing = _CLASS.search(keep)
        if existing:
            keep = _CLASS.sub("", keep, count=1)
            classes = existing.group(1).split() + classes

        return f"<{tag}{keep} class=\"{' '.join(classes)}\"{close}>"

    return _TAG.sub(rewrite, svg)


def strip_ids(svg: str, stem: str) -> str:
    """Remove graphviz's internal <title> elements from clusters, edges, and the
    graph itself. Left in, they surface as browser tooltips ("cluster_triage",
    "q->none", "staff") when the reader hovers a diagram. Node titles are KEPT —
    the app reads them to identify the node a reader clicks."""
    # edge titles contain the escaped arrow; cluster titles start with cluster_.
    svg = re.sub(r"<title>[^<]*&#45;&gt;[^<]*</title>", "", svg)
    svg = re.sub(r"<title>[^<]*-&gt;[^<]*</title>", "", svg)
    svg = re.sub(r"<title>cluster_[^<]*</title>", "", svg)
    # The graph title sits directly inside the root graph group; drop only that
    # one, never a node that happens to share the diagram's name (e.g. the
    # "staff" or "deploy" node inside staff.svg / deploy.svg).
    svg = re.sub(
        r'(<g id="graph0"[^>]*class="graph">\s*)<title>[^<]*</title>',
        r"\1",
        svg,
        count=1,
    )
    return svg


def _dims(svg: str) -> tuple[float, float]:
    m = re.search(r'width="(\d+(?:\.\d+)?)pt" height="(\d+(?:\.\d+)?)pt"', svg)
    return (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)


def pack(sizes: dict[str, tuple[float, float]]) -> list[dict]:
    """Masonry-pack the plates into NCOLS columns in PLATE_ORDER, returning each
    plate's position and size in canvas units. Mirrors the poster arrangement so
    the interactive canvas reads the same way the printed map does."""
    plates = [
        {"name": n, "w": sizes[n][0], "h": sizes[n][1] + TITLEBLOCK}
        for n in PLATE_ORDER
        if n in sizes
    ]
    heights = [0.0] * NCOLS
    cols: list[list[dict]] = [[] for _ in range(NCOLS)]
    for p in plates:
        i = heights.index(min(heights))
        cols[i].append(p)
        heights[i] += p["h"] + GUTTER

    x = 0.0
    for col in cols:
        cw = max((p["w"] for p in col), default=0.0)
        y = 0.0
        for p in col:
            p["x"], p["y"] = x, y
            p["col"] = cw
            y += p["h"] + GUTTER
        x += cw + GUTTER

    for p in plates:
        p["w"] = round(p["w"], 1)
        p["h"] = round(p["h"], 1)
        p["x"] = round(p["x"], 1)
        p["y"] = round(p["y"], 1)
        p.pop("col", None)
    return plates


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, tuple[float, float]] = {}
    for src in sorted(DOT.glob("*.dot")):
        r = subprocess.run(["dot", "-Tsvg", *SPACING, str(src)], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"graphviz failed on {src.name}:\n{r.stderr}")
        svg = themify(r.stdout)
        svg = strip_ids(svg, src.stem)
        svg = re.sub(r"<\?xml.*?\?>|<!DOCTYPE.*?>|<!--.*?-->", "", svg, flags=re.S)
        sizes[src.stem] = _dims(svg)
        (OUT / f"{src.stem}.svg").write_text(svg.strip())
        print(f"  {src.stem:<11} {sizes[src.stem][0]:.0f} x {sizes[src.stem][1]:.0f}")

    layout = pack(sizes)
    # trailing newline so the committed file stays Prettier-clean after a regen
    (OUT / "layout.json").write_text(json.dumps(layout, indent=2) + "\n")
    print(f"wrote {len(sizes)} diagrams + layout.json to {OUT}")


if __name__ == "__main__":
    main()
