# Provenance Brand Mark — Design

**Date:** 2026-06-18
**Status:** Approved (direction), pending spec review
**Author:** brainstorming session

## Purpose

Provenance has no visual identity anywhere in the repo today — no recorder
extension icon, no analyzer favicon, no logo. The immediate trigger is a
**production build of the recorder**, whose VSIX wants a 128×128 icon. Rather
than make a one-off icon, we are establishing a single **whole-system brand
mark** used across the recorder, the analyzer, and the README.

## Concept

A **geometric, minimal hash-chain mark**: two interlocking rounded-square chain
links, woven with a true over/under. This expresses the system's core — a
tamper-evident hash chain and chain-of-custody — without being literal or
"crypto-bro." It is one compact shape, so it scales from a 16px favicon to a
256px Marketplace tile and reads at every size.

The weave is the load-bearing detail: the ink link passes **over** the accent
link at the **top** crossing and **under** at the **bottom** crossing, so the
two links genuinely interlock (not one flatly stacked on the other).

## Palette — monochrome + orange accent

Ink-on-white with a single orange accent. Two surface variants, because the
mark must work on the analyzer's dark UI as well as the Marketplace's white tile.

| Token      | Light surface | Dark surface |
| ---------- | ------------- | ------------ |
| Ink / line | `#18181b`     | `#fafafa`    |
| Accent     | `#EA580C`     | `#F97316`    |
| Background | `#ffffff`     | transparent  |

(The accent brightens slightly on dark for contrast; same hue family.)

## Construction (symbol)

Single SVG master per surface variant. Built from two `rect` links + one clip
path that re-draws the ink link at the top crossing to create the weave. No
external fonts, no raster, no gradients — pure vector.

Reference geometry (viewBox `0 0 256 256`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#ffffff"/>            <!-- omit/transparent for dark -->
  <defs>
    <clipPath id="topcross"><rect x="92" y="56" width="38" height="38"/></clipPath>
  </defs>
  <!-- base ink link -->
  <rect x="50" y="74" width="96" height="104" rx="34" fill="none" stroke="#18181b" stroke-width="18"/>
  <!-- accent link drawn over (covers ink at BOTH crossings) -->
  <rect x="110" y="74" width="96" height="104" rx="34" fill="none" stroke="#EA580C" stroke-width="18"/>
  <!-- re-draw ink ONLY at the top crossing so ink weaves over accent there -->
  <g clip-path="url(#topcross)">
    <rect x="50" y="74" width="96" height="104" rx="34" fill="none" stroke="#18181b" stroke-width="18"/>
  </g>
</svg>
```

The dark variant is identical with ink `#fafafa`, accent `#F97316`, and no
background rect (transparent).

For the standalone icon/favicon the links are inset within the 256-unit canvas
as above. For the Marketplace tile (128×128) the same artwork is exported on a
white background.

## Wordmark lockup

A horizontal lockup: the symbol at left, the wordmark **"Provenance"** at right,
optically centered, with clear space equal to one link's corner radius.

The wordmark uses the analyzer's existing typeface — the Tailwind default
**system-sans stack** (`ui-sans-serif, system-ui, -apple-system, "Segoe UI",
Helvetica, Arial, sans-serif`), weight 600, slight negative tracking, title case.
The analyzer defines no custom font, so this keeps the brand consistent with the
product UI for free.

Because system fonts render differently per machine, the lockup ships as a
**rendered PNG** (light + dark) for portable embedding (README, headers), with
the SVG source kept as the editable master.

## Deliverables & wiring

All source masters live in a new top-level `brand/` directory.

| File                                                 | Purpose                                |
| ---------------------------------------------------- | -------------------------------------- |
| `brand/provenance-mark.svg`                          | symbol, light surface (master)         |
| `brand/provenance-mark-dark.svg`                     | symbol, dark surface (master)          |
| `brand/provenance-lockup.svg`                        | symbol + wordmark (master)             |
| `brand/provenance-lockup-dark.svg`                   | lockup, dark surface (master)          |
| `brand/exports/icon-128.png`                         | recorder VSIX icon (white bg)          |
| `brand/exports/favicon.svg` + `favicon-32.png`       | analyzer favicon                       |
| `brand/exports/lockup-light.png` / `lockup-dark.png` | README / headers                       |
| `brand/README.md`                                    | tokens, variants, and how to re-export |

Wiring (one pass, all three surfaces):

1. **Recorder** — `vsce` only packages files **inside** the extension folder, so
   the 128×128 PNG is copied to `packages/recorder/icon.png` and referenced as
   `"icon": "icon.png"` in `packages/recorder/package.json` so the production
   VSIX carries the tile. (`brand/exports/icon-128.png` remains the source of
   truth; `brand/README.md` documents the copy step.)
2. **Analyzer** — add `favicon.svg` + 32px fallback under
   `packages/analyzer/public/` and reference from `index.html`; optionally place
   the lockup in the app header.
3. **README** — embed `lockup-light.png` at the top.

Exports are produced with `rsvg-convert` (already available on this machine).
`brand/README.md` documents the exact commands so assets can be regenerated.

## Interactions / things to watch

- **Extension-hash allowlist.** Adding an icon changes the recorder VSIX, hence
  its build hash. Per CLAUDE.md, when the recorder ships a new VSIX the
  analyzer's `known-good-extension-hashes.json` must be refreshed via
  `npm run update-hashes`. This is a consequence of the _production build_, not
  of the logo per se, but the logo change is what lands in that build — flag it
  so it is not forgotten when the prod VSIX is cut.
- **No new dependencies.** `rsvg-convert` is a local CLI, not an npm dep. No
  `package.json` dependency is added by this work.
- **VS Code icon constraints.** Marketplace icon must be ≥128×128 PNG, square,
  and not transparent-on-transparent in a way that vanishes on white — hence the
  white-background export for the recorder tile specifically.

## Out of scope

- Animated / motion variants.
- A full brand guidelines document beyond `brand/README.md` (tokens + usage).
- Re-theming the analyzer UI; we only add a favicon and (optionally) a header
  lockup.
- Actually cutting the production VSIX and refreshing the hash allowlist — that
  is the follow-on production-build task; this task only makes that build's icon
  available and flags the allowlist step.

## Success criteria

- Mark renders correctly (weave intact) at 16, 32, 128, and 256px on both light
  and dark backgrounds.
- Recorder `package.json` references a valid 128×128 icon; a `vsce package` dry
  run picks it up without warnings.
- Analyzer serves the favicon; browser tab shows the mark.
- README displays the lockup.
- No new npm dependencies; no changes to the log format, API schemas, or any
  package's runtime code beyond asset references.
