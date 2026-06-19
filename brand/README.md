# Provenance brand assets

The Provenance mark is two interlocking rounded-square chain links, woven with a
true over/under — the ink link passes **over** the accent link at the top
crossing and **under** at the bottom. It expresses the system's tamper-evident
hash chain / chain-of-custody.

Design spec: [`../docs/superpowers/specs/2026-06-18-provenance-brand-mark-design.md`](../docs/superpowers/specs/2026-06-18-provenance-brand-mark-design.md)

## Color tokens

| Token       | Light surface | Dark surface |
| ----------- | ------------- | ------------ |
| Ink / line  | `#18181b`     | `#fafafa`    |
| Accent      | `#EA580C`     | `#F97316`    |
| Background  | `#ffffff`     | transparent  |

The accent brightens on dark surfaces for contrast; same hue family.

## Source masters

| File | Use |
| ---- | --- |
| `provenance-mark.svg` | symbol, light surface |
| `provenance-mark-dark.svg` | symbol, dark surface |
| `provenance-lockup.svg` | symbol + wordmark, light surface |
| `provenance-lockup-dark.svg` | symbol + wordmark, dark surface |
| `exports/favicon.svg` | symbol, adapts to light/dark via `prefers-color-scheme` |

The wordmark uses the analyzer's typeface — the Tailwind default system-sans
stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial,
sans-serif`), weight 600. Because system fonts render per-machine, ship the
**PNG** lockups for portable embedding; keep the SVG as the editable master.

## Exports

| File | Where it's wired |
| ---- | ---------------- |
| `exports/icon-128.png` | recorder VSIX icon → copied to `packages/recorder/icon.png` |
| `exports/favicon.svg`, `exports/favicon-32.png` | analyzer → `packages/analyzer/public/` |
| `exports/lockup-light.png`, `exports/lockup-dark.png` | README header (`<picture>`) |

## Regenerating exports

Rendered with [`rsvg-convert`](https://gitlab.gnome.org/GNOME/librsvg)
(`brew install librsvg`). From this directory:

```sh
# Recorder VSIX icon (128×128, white background)
rsvg-convert -b white -w 128 -h 128 provenance-mark.svg -o exports/icon-128.png

# Analyzer favicon PNG fallback (32×32)
rsvg-convert -b white -w 32 -h 32 exports/favicon.svg -o exports/favicon-32.png

# README lockups
rsvg-convert -b white    -w 1000 -h 256 provenance-lockup.svg      -o exports/lockup-light.png
rsvg-convert -b "#0f1115" -w 1000 -h 256 provenance-lockup-dark.svg -o exports/lockup-dark.png
```

After regenerating, copy into place:

```sh
cp exports/icon-128.png ../packages/recorder/icon.png
cp exports/favicon.svg exports/favicon-32.png ../packages/analyzer/public/
```

## Note for the production recorder build

Adding/changing the VSIX icon changes the recorder build hash. When the
production VSIX is cut, refresh the analyzer's known-good extension-hash
allowlist with `npm run update-hashes` (see the root README, "Course staff: key
& manifest workflow"). Otherwise the analyzer will flag the new build as
unrecognized.
