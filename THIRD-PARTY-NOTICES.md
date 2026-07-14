# Third-Party Notices

Provenance is licensed under the Apache License, Version 2.0 (see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE)). Provenance's own source code redistributes a number of third-party
open-source components as part of three **distributed artifacts**:

- **Recorder** (`packages/recorder`) — packaged as a VSIX and installed into VS Code. It
  bundles its own runtime dependencies.
- **Analyzer** (`packages/analyzer`) — built by Vite into a static single-page app and
  served to browsers. The production bundle includes React and the rest of its runtime
  dependencies.
- **Server** (`packages/server`) — run as a long-lived Node.js process. It ships its
  runtime dependencies via `node_modules` (or an equivalent bundle) at deploy time.

Each of the above also pulls in code from this repo's internal, non-published libraries —
`packages/log-core`, `packages/shared`, and `packages/analysis-core` — which are not
separately listed because they are not independently distributed; their own third-party
dependencies are folded into the artifact that bundles them (below).

## Scope and methodology

The lists below are the **full transitive set of production dependencies** actually
resolved into `node_modules` for each distributed artifact — not just the packages
listed directly in each package's `dependencies` — obtained via:

```sh
npm ls --workspace=packages/<recorder|analyzer|server> --omit=dev --all --json
```

`devDependencies` (build/test tooling such as `vitest`, `eslint`, `tsx`, `esbuild`,
`vite`, `drizzle-kit`, `testcontainers`, `@vscode/vsce`, etc.) are **excluded** — none of
that code ships inside the VSIX, the SPA bundle, or the deployed server process. Optional
dependencies that `npm ls` lists but that were **not actually installed** on this machine
(e.g. the ~50 alternate database drivers `drizzle-orm` supports as `optionalDependencies` —
`mysql2`, `better-sqlite3`, `@vercel/postgres`, etc. — none of which this project uses)
are also excluded; they carry no version because npm never resolved them, so there is
nothing to redistribute.

For every package below, the license identifier and copyright/author line were read
directly from that package's installed `node_modules/<pkg>/package.json` (`license`
field) and, where present, its shipped `LICENSE`/`NOTICE`/`COPYING` file — never
invented or guessed. Rows marked **inferred** carry no `LICENSE` file or `author` field
of their own; the copyright line shown was copied from a sibling package published from
the same npm scope/monorepo (e.g. an unscoped `@radix-ui/*` helper package next to
`@radix-ui/react-context`, which does ship a `LICENSE`). Rows marked **UNVERIFIED** could
not be attributed to a specific copyright holder at all — see the per-section notes.

Full license text for every package is available in its own `node_modules/<pkg>/LICENSE`
(or equivalent) file, or from the package's entry on [npmjs.com](https://www.npmjs.com/).
None of the Apache-2.0-licensed dependencies below ship a `NOTICE` file, so there is no
additional NOTICE text to reproduce per the Apache License §4(d).

**Native platform binaries:** `@node-rs/argon2-<platform>` and `@node-rs/bcrypt-<platform>`
are per-platform optional dependencies of `@node-rs/argon2` / `@node-rs/bcrypt`; npm
installs only the one matching the build machine. This document was generated on
`darwin-arm64` and lists the `-darwin-arm64` variants actually present; a Linux
deployment (see `docs/admin-guide.md`) resolves the equivalent `-linux-x64-gnu` (or
similar) package instead, under the identical license and copyright holder.

---

## Recorder (`packages/recorder`) — VS Code extension

17 third-party production dependencies (direct `dependencies` plus full transitive
closure, via `@provenance/log-core`).

| Package | Version | License | Copyright | Notes |
| --- | --- | --- | --- | --- |
| @noble/ciphers | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/ed25519 | 3.1.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/hashes | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| canonicalize | 3.0.0 | Apache-2.0 | _not stated in package metadata_ | **UNVERIFIED** — see note below. |
| core-util-is | 1.0.3 | MIT | Isaac Z. Schlueter \<i@izs.me\> (http://blog.izs.me/) |  |
| immediate | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |  |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |  |
| isarray | 1.0.0 | MIT | Julian Gruber |  |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | Stuart Knightley \<stuart@stuartk.com\> |  |
| lie | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband |  |
| pako | 1.0.11 | (MIT AND Zlib) | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |  |
| process-nextick-args | 2.0.1 | MIT | Copyright (c) 2015 Calvin Metcalf |  |
| readable-stream | 2.3.8 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| safe-buffer | 5.1.2 | MIT | Feross Aboukhadijeh |  |
| setimmediate | 1.0.5 | MIT | YuzuJS |  |
| string_decoder | 1.1.1 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| util-deprecate | 1.0.2 | MIT | Nathan Rajlich \<nathan@tootallnate.net\> (http://n8.io/) |  |

License breakdown: 13 MIT, 1 Apache-2.0, 1 ISC, 1 dual MIT/GPL-3.0-or-later (`jszip`,
consumed here under its MIT option), 1 dual MIT/Zlib (`pako`).

**`canonicalize@3.0.0` (Apache-2.0) — copyright holder not verifiable.** Its shipped
`LICENSE` file is the unfilled Apache License 2.0 template (the copyright line still
reads the literal placeholder `Copyright [yyyy] [name of copyright owner]`), and
`package.json` has no `author` field. The package (`log-core`'s dependency) is
`erdtman/canonicalize` per its `repository`/`homepage` field, but that is a GitHub
handle, not a confirmed legal copyright holder — not asserted here. The Apache-2.0
license text itself is included verbatim in the installed package and is not in
question; only the "who holds the copyright" line is unfilled upstream.

---

## Analyzer (`packages/analyzer`) — web SPA

160 third-party production dependencies (direct `dependencies` plus full transitive
closure, via `@provenance/analysis-core`, `@provenance/log-core`, and `@provenance/shared`).

| Package | Version | License | Copyright | Notes |
| --- | --- | --- | --- | --- |
| @babel/runtime | 7.29.2 | MIT | The Babel Team (https://babel.dev/team) |  |
| @floating-ui/core | 1.7.5 | MIT | atomiks |  |
| @floating-ui/dom | 1.7.6 | MIT | atomiks |  |
| @floating-ui/react-dom | 2.1.8 | MIT | atomiks |  |
| @floating-ui/utils | 0.2.11 | MIT | atomiks |  |
| @hookform/resolvers | 3.10.0 | MIT | bluebill1049 \<bluebill1049@hotmail.com\> |  |
| @monaco-editor/loader | 1.7.0 | MIT | Suren Atoyan \<contact@surenatoyan.com\> |  |
| @monaco-editor/react | 4.7.0 | MIT | Suren Atoyan \<contact@surenatoyan.com\> |  |
| @noble/ciphers | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/ed25519 | 3.1.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/hashes | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @radix-ui/number | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/primitive | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-arrow | 1.1.7 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-collection | 1.1.7 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-compose-refs | 1.1.2 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-context | 1.1.2 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-context | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-dialog | 1.1.15 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-direction | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-dismissable-layer | 1.1.11 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-dropdown-menu | 2.1.16 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-focus-guards | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-focus-scope | 1.1.7 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-id | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-menu | 2.1.16 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-popper | 1.2.8 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-portal | 1.1.9 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-presence | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-primitive | 2.1.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-primitive | 2.1.4 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-progress | 1.1.8 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-roving-focus | 1.1.11 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-scroll-area | 1.2.10 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-separator | 1.1.8 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-slider | 1.3.6 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-slot | 1.2.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-slot | 1.2.4 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-tabs | 1.1.13 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-tooltip | 1.2.8 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-use-callback-ref | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-use-controllable-state | 1.2.2 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-use-effect-event | 0.0.2 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/react-use-escape-keydown | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-use-layout-effect | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-use-previous | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-use-rect | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-use-size | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @radix-ui/react-visually-hidden | 1.2.3 | MIT | Copyright (c) 2022 WorkOS |  |
| @radix-ui/rect | 1.1.1 | MIT | Copyright (c) 2022 WorkOS | inferred |
| @remix-run/router | 1.23.2 | MIT | Remix Software \<hello@remix.run\> |  |
| @tanstack/query-core | 5.100.11 | MIT | tannerlinsley |  |
| @tanstack/react-query | 5.100.11 | MIT | tannerlinsley |  |
| @tanstack/react-table | 8.21.3 | MIT | Tanner Linsley |  |
| @tanstack/react-virtual | 3.13.24 | MIT | Tanner Linsley |  |
| @tanstack/table-core | 8.21.3 | MIT | Tanner Linsley |  |
| @tanstack/virtual-core | 3.14.0 | MIT | Tanner Linsley |  |
| @types/d3-array | 3.2.2 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-color | 3.1.3 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-ease | 3.0.2 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-interpolate | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-path | 3.1.1 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-scale | 4.0.9 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-shape | 3.1.8 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-time | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/d3-timer | 3.0.2 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/diff | 7.0.2 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/pako | 2.0.4 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/prop-types | 15.7.15 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/raf | 3.4.3 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/react | 18.3.29 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/react-dom | 18.3.7 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/trusted-types | 2.0.7 | MIT | Copyright (c) Microsoft Corporation. |  |
| aria-hidden | 1.2.6 | MIT | Anton Korzunov \<thekashey@gmail.com\> |  |
| base64-arraybuffer | 1.0.2 | MIT | Niklas von Hertzen |  |
| canonicalize | 3.0.0 | Apache-2.0 | _not stated in package metadata_ | **UNVERIFIED** — see note below. |
| canvg | 3.0.11 | MIT | Copyright (c) 2010 - present Gabe Lerner (gabelerner@gmail.com) |  |
| class-variance-authority | 0.7.1 | Apache-2.0 | Joe Bell (https://joebell.co.uk) |  |
| clsx | 2.1.1 | MIT | Luke Edwards |  |
| core-js | 3.49.0 | MIT | Denis Pushkarev |  |
| core-util-is | 1.0.3 | MIT | Isaac Z. Schlueter \<i@izs.me\> (http://blog.izs.me/) |  |
| css-line-break | 2.1.0 | MIT | Niklas von Hertzen |  |
| csstype | 3.2.3 | MIT | Fredrik Nicol \<fredrik.nicol@gmail.com\> |  |
| d3-array | 3.2.4 | ISC | Mike Bostock |  |
| d3-color | 3.1.0 | ISC | Mike Bostock |  |
| d3-ease | 3.0.1 | BSD-3-Clause | Mike Bostock |  |
| d3-format | 3.1.2 | ISC | Mike Bostock |  |
| d3-interpolate | 3.0.1 | ISC | Mike Bostock |  |
| d3-path | 3.1.0 | ISC | Mike Bostock |  |
| d3-scale | 4.0.2 | ISC | Mike Bostock |  |
| d3-shape | 3.2.0 | ISC | Mike Bostock |  |
| d3-time | 3.1.0 | ISC | Mike Bostock |  |
| d3-time-format | 4.1.0 | ISC | Mike Bostock |  |
| d3-timer | 3.0.1 | ISC | Mike Bostock |  |
| date-fns | 3.6.0 | MIT | Copyright (c) 2021 Sasha Koss and Lesha Koss https://kossnocorp.mit-license.org |  |
| decimal.js-light | 2.5.1 | MIT | Michael Mclaughlin |  |
| detect-node-es | 1.1.0 | MIT | Ilya Kantor |  |
| diff | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker \<kpdecker@gmail.com\> |  |
| dom-helpers | 5.2.1 | MIT | Jason Quense |  |
| dompurify | 3.4.5 | (MPL-2.0 OR Apache-2.0) | Dr.-Ing. Mario Heiderich, Cure53 \<mario@cure53.de\> |  |
| eventemitter3 | 4.0.7 | MIT | Arnout Kazemier |  |
| fast-equals | 5.4.0 | MIT | tony_quetano@planttheidea.com |  |
| fast-png | 6.4.0 | MIT | Michaël Zasso |  |
| fflate | 0.8.3 | MIT | Arjun Barrett \<arjunbarrett@gmail.com\> |  |
| get-nonce | 1.0.1 | MIT | Anton Korzunov \<thekashey@gmail.com\> |  |
| html2canvas | 1.4.1 | MIT | Niklas von Hertzen |  |
| immediate | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |  |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |  |
| internmap | 2.0.3 | ISC | Mike Bostock |  |
| iobuffer | 5.4.0 | MIT | Michaël Zasso |  |
| isarray | 1.0.0 | MIT | Julian Gruber |  |
| js-tokens | 4.0.0 | MIT | Simon Lydell |  |
| jspdf | 4.2.1 | MIT | (c) 2010-2025 James Hall, https://github.com/MrRio/jsPDF; (c) 2015-2025 yWorks GmbH |  |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | Stuart Knightley \<stuart@stuartk.com\> |  |
| lie | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband |  |
| lodash | 4.18.1 | MIT | John-David Dalton \<john.david.dalton@gmail.com\> |  |
| loose-envify | 1.4.0 | MIT | Andres Suarez \<zertosh@gmail.com\> |  |
| lucide-react | 0.511.0 | ISC | Eric Fennis |  |
| monaco-editor | 0.52.2 | MIT | Microsoft Corporation |  |
| object-assign | 4.1.1 | MIT | Sindre Sorhus |  |
| pako | 1.0.11 | (MIT AND Zlib) | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |  |
| pako | 2.1.0 | (MIT AND Zlib) | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |  |
| performance-now | 2.1.0 | MIT | Braveg1rl \<braveg1rl@outlook.com\> |  |
| process-nextick-args | 2.0.1 | MIT | Copyright (c) 2015 Calvin Metcalf |  |
| prop-types | 15.8.1 | MIT | Copyright (c) 2013-present, Facebook, Inc. |  |
| raf | 3.4.1 | MIT | Chris Dickinson \<chris@neversaw.us\> |  |
| react | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |  |
| react-dom | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |  |
| react-hook-form | 7.76.0 | MIT | Beier(Bill) Luo \<bluebill1049@hotmail.com\> |  |
| react-is | 16.13.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |  |
| react-is | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |  |
| react-remove-scroll | 2.7.2 | MIT | Anton Korzunov \<thekashey@gmail.com\> |  |
| react-remove-scroll-bar | 2.3.8 | MIT | Anton Korzunov \<thekashey@gmail.com\> |  |
| react-router | 6.30.3 | MIT | Remix Software \<hello@remix.run\> |  |
| react-router-dom | 6.30.3 | MIT | Remix Software \<hello@remix.run\> |  |
| react-smooth | 4.0.4 | MIT | JasonHzq |  |
| react-style-singleton | 2.2.3 | MIT | Anton Korzunov (thekashey@gmail.com) |  |
| react-transition-group | 4.4.5 | BSD-3-Clause | Copyright (c) 2018, React Community |  |
| readable-stream | 2.3.8 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| recharts | 2.15.4 | MIT | recharts group |  |
| recharts-scale | 0.4.5 | MIT | recharts group |  |
| regenerator-runtime | 0.13.11 | MIT | Ben Newman \<bn@cs.stanford.edu\> |  |
| rgbcolor | 1.0.1 | MIT OR SEE LICENSE IN FEEL-FREE.md | Sebastian Vollnhals \<sebastian@vollnhals.info\> |  |
| safe-buffer | 5.1.2 | MIT | Feross Aboukhadijeh |  |
| scheduler | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |  |
| setimmediate | 1.0.5 | MIT | YuzuJS |  |
| stackblur-canvas | 2.7.0 | MIT | Mario Klingemann |  |
| state-local | 1.0.7 | MIT | Suren Atoyan \<contact@surenatoyan.com\> |  |
| string_decoder | 1.1.1 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| svg-pathdata | 6.0.3 | MIT | Nicolas Froidure |  |
| tailwind-merge | 3.6.0 | MIT | Dany Castillo |  |
| text-segmentation | 1.0.3 | MIT | Niklas von Hertzen |  |
| tiny-invariant | 1.3.3 | MIT | Alex Reardon \<alexreardon@gmail.com\> |  |
| tslib | 2.8.1 | 0BSD | Microsoft Corp. |  |
| use-callback-ref | 1.3.3 | MIT | theKashey \<thekashey@gmail.com\> |  |
| use-sidecar | 1.1.3 | MIT | theKashey \<thekashey@gmail.com\> |  |
| util-deprecate | 1.0.2 | MIT | Nathan Rajlich \<nathan@tootallnate.net\> (http://n8.io/) |  |
| utrie | 1.0.2 | MIT | Niklas von Hertzen |  |
| victory-vendor | 36.9.2 | MIT AND ISC | Formidable |  |
| zod | 3.25.76 | MIT | Colin McDonnell \<zod@colinhacks.com\> |  |

License breakdown: 135 MIT, 13 ISC, 3 BSD-3-Clause, 2 Apache-2.0, 2 dual MIT/Zlib
(`pako`), 1 dual MPL-2.0/Apache-2.0 (`dompurify`, consumed here under its Apache-2.0
option), 1 dual MIT/GPL-3.0-or-later (`jszip`), 1 `0BSD` (`tslib`), 1 MIT+ISC
(`victory-vendor`, a vendored bundle of separately-licensed D3 modules), 1
MIT-with-alternate-file (`rgbcolor`, whose `package.json` license field is literally
`"MIT OR SEE LICENSE IN FEEL-FREE.md"` — consumed here under its MIT option).

`canonicalize@3.0.0` has the same unverifiable-copyright situation described in the
Recorder section above.

`@radix-ui/*` rows marked **inferred**: 12 of the 33 Radix packages pulled in here ship
no `LICENSE` file of their own. Their copyright was taken from a sibling package
(`@radix-ui/react-context@1.1.3`, nested under `react-progress`) that does ship one and
is published from the same `@radix-ui` npm scope/monorepo, under the same MIT license.

---

## Server (`packages/server`) — Node API service

141 third-party production dependencies (direct `dependencies` plus full transitive
closure, via `@provenance/analysis-core` and `@provenance/log-core`). Generated on
`darwin-arm64`; see the native-binary note above for `@node-rs/*`.

| Package | Version | License | Copyright | Notes |
| --- | --- | --- | --- | --- |
| @asteasolutions/zod-to-openapi | 7.3.4 | MIT | Astea Solutions \<info@asteasolutions.com\> |  |
| @hono/node-server | 1.19.14 | MIT | Yusuke Wada \<yusuke@kamawada.com\> |  |
| @hono/zod-openapi | 0.19.10 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors | inferred |
| @hono/zod-validator | 0.7.6 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors | inferred |
| @mapbox/node-pre-gyp | 1.0.11 | BSD-3-Clause | Dane Springmeyer \<dane@mapbox.com\> |  |
| @noble/ciphers | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/ed25519 | 3.1.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @noble/hashes | 2.2.0 | MIT | Paul Miller (https://paulmillr.com) |  |
| @node-rs/argon2 | 1.7.0 | MIT | Copyright (c) 2020-present LongYinan |  |
| @node-rs/argon2-darwin-arm64 | 1.7.0 | MIT | Copyright (c) 2020-present LongYinan | inferred, platform binary |
| @node-rs/bcrypt | 1.9.0 | MIT | LongYinan \<lynweklm@gmail.com\> |  |
| @node-rs/bcrypt-darwin-arm64 | 1.9.0 | MIT | LongYinan \<lynweklm@gmail.com\> | platform binary |
| @oslojs/asn1 | 1.0.0 | MIT | pilcrowOnPaper |  |
| @oslojs/binary | 1.0.0 | MIT | pilcrowOnPaper |  |
| @oslojs/crypto | 1.0.1 | MIT | pilcrowOnPaper |  |
| @oslojs/encoding | 0.4.1 | MIT | pilcrowOnPaper |  |
| @oslojs/encoding | 1.1.0 | MIT | pilcrowOnPaper |  |
| @oslojs/jwt | 0.2.0 | MIT | pilcrowOnPaper |  |
| @phc/format | 1.0.0 | MIT | Simone Primarosa \<simonepri@outlook.com\> |  |
| @pinojs/redact | 0.4.0 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| @types/node | 20.19.41 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/nodemailer | 8.0.0 | MIT | Copyright (c) Microsoft Corporation. |  |
| @types/papaparse | 5.5.2 | MIT | Copyright (c) Microsoft Corporation. |  |
| abbrev | 1.1.1 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| agent-base | 6.0.2 | MIT | Nathan Rajlich \<nathan@tootallnate.net\> |  |
| ansi-regex | 5.0.1 | MIT | Sindre Sorhus |  |
| aproba | 2.1.0 | ISC | Rebecca Turner \<me@re-becca.org\> |  |
| arctic | 3.7.0 | MIT | pilcrowOnPaper |  |
| are-we-there-yet | 2.0.0 | ISC | GitHub Inc. |  |
| argon2 | 0.31.2 | MIT | Ranieri Althoff \<ranisalt+argon2@gmail.com\> |  |
| atomic-sleep | 1.0.0 | MIT | David Mark Clements |  |
| aws4fetch | 1.0.20 | MIT | Michael Hart \<michael.hart.au@gmail.com\> |  |
| balanced-match | 1.0.2 | MIT | Julian Gruber |  |
| brace-expansion | 1.1.14 | MIT | Julian Gruber |  |
| busboy | 1.6.0 | MIT | Brian White \<mscdex@mscdex.net\> |  |
| canonicalize | 3.0.0 | Apache-2.0 | _not stated in package metadata_ | **UNVERIFIED** — see note below. |
| chownr | 2.0.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| color-support | 1.1.3 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| concat-map | 0.0.1 | MIT | James Halliday |  |
| console-control-strings | 1.1.0 | ISC | Rebecca Turner \<me@re-becca.org\> |  |
| core-util-is | 1.0.3 | MIT | Isaac Z. Schlueter \<i@izs.me\> |  |
| cron-parser | 4.9.0 | MIT | Harri Siirak |  |
| debug | 4.4.3 | MIT | Josh Junon (https://github.com/qix-) |  |
| delegates | 1.0.0 | MIT | Copyright (c) 2015 TJ Holowaychuk \<tj@vision-media.ca\> |  |
| detect-libc | 2.1.2 | Apache-2.0 | Lovell Fuller \<npm@lovell.info\> |  |
| diff | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker \<kpdecker@gmail.com\> |  |
| drizzle-orm | 0.45.2 | Apache-2.0 | Drizzle Team |  |
| emoji-regex | 8.0.0 | MIT | Mathias Bynens |  |
| fs-minipass | 2.1.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| fs.realpath | 1.0.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| gauge | 3.0.2 | ISC | Rebecca Turner \<me@re-becca.org\> |  |
| get-caller-file | 2.0.5 | ISC | Stefan Penner |  |
| glob | 7.2.3 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| has-unicode | 2.0.1 | ISC | Rebecca Turner \<me@re-becca.org\> |  |
| hono | 4.12.21 | MIT | Yusuke Wada \<yusuke@kamawada.com\> |  |
| https-proxy-agent | 5.0.1 | MIT | Nathan Rajlich \<nathan@tootallnate.net\> |  |
| immediate | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |  |
| inflight | 1.0.6 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |  |
| is-fullwidth-code-point | 3.0.0 | MIT | Sindre Sorhus |  |
| isarray | 1.0.0 | MIT | Julian Gruber |  |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | Stuart Knightley \<stuart@stuartk.com\> |  |
| lie | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband |  |
| luxon | 3.7.2 | MIT | Isaac Cambron |  |
| make-dir | 3.1.0 | MIT | Sindre Sorhus |  |
| minimatch | 3.1.5 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| minipass | 3.3.6 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| minipass | 5.0.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| minizlib | 2.1.2 | MIT | Isaac Z. Schlueter \<i@izs.me\> |  |
| mkdirp | 1.0.4 | MIT | Copyright James Halliday (mail@substack.net) and Isaac Z. Schlueter (i@izs.me) |  |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |  |
| node-addon-api | 7.1.1 | MIT | Copyright (c) 2017 Node.js API collaborators |  |
| node-fetch | 2.7.0 | MIT | David Frank |  |
| nodemailer | 8.0.7 | MIT-0 | Andris Reinman |  |
| nopt | 5.0.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| npmlog | 5.0.1 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| object-assign | 4.1.1 | MIT | Sindre Sorhus |  |
| on-exit-leak-free | 2.1.2 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| once | 1.4.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| openapi3-ts | 4.5.0 | MIT | Pedro J. Molina / Metadev |  |
| oslo | 1.2.1 | MIT | pilcrowOnPaper |  |
| pako | 1.0.11 | (MIT AND Zlib) | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |  |
| papaparse | 5.5.3 | MIT | Matthew Holt |  |
| path-is-absolute | 1.0.1 | MIT | Sindre Sorhus |  |
| pend | 1.2.0 | MIT | Andrew Kelley \<superjoe30@gmail.com\> |  |
| pg | 8.21.0 | MIT | Brian Carlson \<brian.m.carlson@gmail.com\> |  |
| pg-boss | 10.4.2 | MIT | timgit |  |
| pg-cloudflare | 1.4.0 | MIT | Copyright (c) 2010 - 2021 Brian Carlson |  |
| pg-connection-string | 2.13.0 | MIT | Blaine Bublitz \<blaine@iceddev.com\> |  |
| pg-int8 | 1.0.1 | ISC | Copyright © 2017, Charmander \<~@charmander.me\> |  |
| pg-pool | 3.14.0 | MIT | Brian M. Carlson |  |
| pg-protocol | 1.14.0 | MIT | Copyright (c) 2010 - 2021 Brian Carlson |  |
| pg-types | 2.2.0 | MIT | Brian M. Carlson |  |
| pgpass | 1.0.5 | MIT | Hannes Hörl \<hannes.hoerl+pgpass@snowreporter.com\> |  |
| pino | 9.14.0 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| pino-abstract-transport | 2.0.0 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| pino-http | 10.5.0 | MIT | David Mark Clements |  |
| pino-std-serializers | 7.1.0 | MIT | James Sumners \<james.sumners@gmail.com\> |  |
| postgres | 3.4.9 | Unlicense | Rasmus Porsager \<rasmus@porsager.com\> |  |
| postgres-array | 2.0.0 | MIT | Ben Drucker |  |
| postgres-bytea | 1.0.1 | MIT | Ben Drucker |  |
| postgres-date | 1.0.7 | MIT | Ben Drucker |  |
| postgres-interval | 1.2.0 | MIT | Ben Drucker |  |
| process-nextick-args | 2.0.1 | MIT | Copyright (c) 2015 Calvin Metcalf |  |
| process-warning | 5.0.0 | MIT | Tomas Della Vedova |  |
| quick-format-unescaped | 4.0.4 | MIT | David Mark Clements |  |
| readable-stream | 2.3.8 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| readable-stream | 3.6.2 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| real-require | 0.2.0 | MIT | Paolo Insogna \<shogun@cowtech.it\> |  |
| rimraf | 3.0.2 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| safe-buffer | 5.1.2 | MIT | Feross Aboukhadijeh |  |
| safe-buffer | 5.2.1 | MIT | Feross Aboukhadijeh |  |
| safe-stable-stringify | 2.5.0 | MIT | Ruben Bridgewater |  |
| semver | 6.3.1 | ISC | GitHub Inc. |  |
| semver | 7.8.0 | ISC | GitHub Inc. |  |
| serialize-error | 8.1.0 | MIT | Sindre Sorhus |  |
| set-blocking | 2.0.0 | ISC | Ben Coe \<ben@npmjs.com\> |  |
| setimmediate | 1.0.5 | MIT | YuzuJS |  |
| signal-exit | 3.0.7 | ISC | Ben Coe \<ben@npmjs.com\> |  |
| sonic-boom | 4.2.1 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| split2 | 4.2.0 | ISC | Matteo Collina \<hello@matteocollina.com\> |  |
| streamsearch | 1.1.0 | MIT | Brian White \<mscdex@mscdex.net\> |  |
| string_decoder | 1.1.1 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| string_decoder | 1.3.0 | MIT | Copyright Node.js contributors. All rights reserved. |  |
| string-width | 4.2.3 | MIT | Sindre Sorhus |  |
| strip-ansi | 6.0.1 | MIT | Sindre Sorhus |  |
| tar | 6.2.1 | ISC | GitHub Inc. |  |
| thread-stream | 3.1.0 | MIT | Matteo Collina \<hello@matteocollina.com\> |  |
| tr46 | 0.0.3 | MIT | Sebastian Mayr \<npm@smayr.name\> |  |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) | Sindre Sorhus |  |
| undici-types | 6.21.0 | MIT | Copyright (c) Matteo Collina and Undici contributors |  |
| util-deprecate | 1.0.2 | MIT | Nathan Rajlich \<nathan@tootallnate.net\> |  |
| webidl-conversions | 3.0.1 | BSD-2-Clause | Domenic Denicola \<d@domenic.me\> |  |
| whatwg-url | 5.0.0 | MIT | Sebastian Mayr \<github@smayr.name\> |  |
| wide-align | 1.1.5 | ISC | Rebecca Turner \<me@re-becca.org\> |  |
| wrappy | 1.0.2 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| xtend | 4.0.2 | MIT | Raynos \<raynos2@gmail.com\> |  |
| yallist | 4.0.0 | ISC | Isaac Z. Schlueter \<i@izs.me\> |  |
| yaml | 2.9.0 | ISC | Eemeli Aro \<eemeli@gmail.com\> |  |
| yauzl | 3.4.0 | MIT | Josh Wolfe \<thejoshwolfe@gmail.com\> |  |
| zod | 3.25.76 | MIT | Colin McDonnell \<zod@colinhacks.com\> |  |

License breakdown: 98 MIT, 32 ISC, 3 Apache-2.0, 2 BSD-3-Clause, 1 BSD-2-Clause, 1 dual
MIT/GPL-3.0-or-later (`jszip`), 1 `MIT-0` (`nodemailer`), 1 dual MIT/Zlib (`pako`), 1
`Unlicense` (`postgres`), 1 dual MIT/CC0-1.0 (`type-fest`, a transitive dep of
`serialize-error`, used here under its MIT option).

`canonicalize@3.0.0` has the same unverifiable-copyright situation described in the
Recorder section above. `@hono/zod-openapi` and `@hono/zod-validator` ship no `LICENSE`
file of their own; their copyright line was taken from the sibling `@hono/node-server`
package (same `@hono` npm scope/monorepo, same MIT license).
`@node-rs/argon2-darwin-arm64` similarly ships no `LICENSE` of its own; taken from the
sibling `@node-rs/argon2` package (same `@node-rs` scope, same MIT license, same
author).

**Excluded (not installed, not distributed):** `drizzle-orm` declares ~50
`optionalDependencies` for database drivers it can integrate with
(`@aws-sdk/client-rds-data`, `@cloudflare/workers-types`, `@electric-sql/pglite`,
`@libsql/client`, `@neondatabase/serverless`, `@op-engineering/op-sqlite`,
`@opentelemetry/api`, `@planetscale/database`, `@prisma/client`,
`@tidbcloud/serverless`, `@upstash/redis`, `@vercel/postgres`, `@xata.io/client`,
`better-sqlite3`, `bun-types`, `expo-sqlite`, `gel`, `knex`, `kysely`, `mysql2`,
`sql.js`, `sqlite3`, and their respective `@types/*` packages). None of these resolved
to an installed package — this project uses the `postgres` and `pg` drivers only — so
none of them are redistributed and none appear in the table above.
