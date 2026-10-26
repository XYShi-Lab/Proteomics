# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Cursor, …) working on this
repository. Humans: see `README.md` for what the tool does and how to use it.

---

## What this is

**Shi Lab Volcano & GO** — a single-page web app for making publication-ready
volcano plots from proteomics differential-expression tables, with GO/organelle
overlays, pathway enrichment, and PNG/SVG export.

It runs **entirely in the browser**. There is no server, no backend, no database,
and no user data ever leaves the machine. Only gene/protein *names* go out, and
only when the user asks for annotation or enrichment.

| | |
|---|---|
| Language | Vanilla ES2017-ish JavaScript, no framework |
| Dependencies | **Zero** runtime dependencies. No npm install needed to run. |
| Build | None for the app. One optional bundling step (see below). |
| Tests | Playwright, in `tests/` |
| Entry point | `index.html` |

---

## Run it

```bash
# Option 1 — just open it. No server needed.
open index.html            # macOS;  Windows: start index.html

# Option 2 — over http://, needed if external APIs refuse a file:// origin
python3 -m http.server 8000
```

Click **Load example dataset** to get data in without a file.

## Build (only for the single-file bundle)

`volcano-studio.html` is a **generated** single-file build — every stylesheet and
script inlined so the app can be emailed or run from a USB stick.

```bash
node tools/build-single.js
```

> **Never hand-edit `volcano-studio.html`.** It is derived output. Edit the files
> under `css/` and `js/`, then regenerate. If you change anything in `css/` or
> `js/` and do not rerun this, the bundle silently goes stale — and most users
> run the bundle, not `index.html`.

## Test

```bash
node tests/run.mjs            # starts its own server, runs the smoke suite
node tests/run.mjs --headed   # watch it
```

Requires Playwright + Chromium. The suite blocks all outbound hosts so it tests
the offline/degraded paths too. **Run it before claiming a change works** — this
app has no type system and a lot of its behaviour is geometric.

---

## Layout

```
index.html              markup + every control; the <script> tags define load order
css/styles.css          all styling (one file, sectioned by comments)
js/util.js              DOM helpers, number/colour formatting, CSV
js/xlsx.js              dependency-free .xlsx reader (ZIP + DecompressionStream)
js/data.js              parsing, column detection, fold-change scale inference
js/stats.js             hypergeometric test + Benjamini-Hochberg FDR
js/pngmeta.js           read/write a settings chunk inside a PNG
js/surface.js           ONE drawing API, two back ends (canvas + SVG)
js/plot.js              the volcano figure: scales, marks, legends, label layout
js/network.js           the enrichment-map pathway network
js/api.js               UniProt / Enrichr / g:Profiler / QuickGO clients
js/demo.js              simulated example dataset
js/app.js               state, wiring, interaction  (the big one, ~2700 lines)
tools/build-single.js   the bundler
tests/                  Playwright suite
docs/                   architecture, domain background, external API contracts
```

**Read before changing anything non-trivial:**

- `docs/ARCHITECTURE.md` — module contracts, data flow, the render pipeline
- `docs/DOMAIN.md` — the proteomics you need to not get the science wrong
- `docs/EXTERNAL-APIS.md` — what the four external services return and how
  failure is handled

---

## Conventions

**Module pattern.** Every file is an IIFE that hangs its public surface off a
global `VP` namespace (`VP.data`, `VP.plot`, …) and ends with an explicit export
block. There are **no ES modules and no `import`/`export`** — deliberately, so the
app works when opened from `file://`. Adding a new module means adding a
`<script src>` tag to `index.html` in dependency order; the bundler picks it up
automatically from those tags.

**Comments explain *why*, not *what*.** Match that. A comment that restates the
code is noise; a comment recording a non-obvious constraint is the point.

**No dependencies.** Do not add a library or a CDN tag. `package.json` exists for
**dev tooling only** — it declares Playwright and the `build`/`test` scripts, and
nothing in it is shipped to the browser. The app keeps zero runtime dependencies:
everything here — the XLSX reader, the force layout, the hypergeometric
test, the PNG chunk writer — is intentionally hand-rolled so the tool keeps
working offline, forever, with nothing to install or vendor. (Playwright in
`tests/` is the one exception and is dev-only.)

**Browser floor.** Current Chrome, Edge, Firefox 113+, Safari 16.4+. The hard
limits are `DecompressionStream` (xlsx reading) and `ResizeObserver`.

---

## Invariants — break these and something subtly fails

1. **Regex literals must parse on the browser floor.** A regex with syntax the
   engine doesn't know is a *parse-time* SyntaxError that kills the whole file,
   not a runtime error in one function. Lookbehind was removed from `data.js` and
   `api.js` for exactly this reason. Don't reintroduce it.

2. **Draw only through `VP.surface`.** `plot.js` must never touch a 2D context
   directly. Both the screen canvas and the SVG export consume the same draw
   calls — that is the only reason the exported figure matches what is on screen.

3. **Transient UI must not reach an export.** Hover affordances (e.g. the legend
   grip outline) are drawn from flags like `state.legendHover`. Export functions
   clear those flags first. If you add a hover decoration to the figure, clear it
   in `exportPng`/`exportSvg` too, and assert it in a test.

4. **`[hidden] { display: none !important; }` in `styles.css` is load-bearing.**
   Any rule that sets `display` outranks the `hidden` attribute's UA style, so an
   invisible overlay would keep swallowing clicks. This bit us once already.

5. **Toasts are `pointer-events: none`.** They float over the stage and the
   results drawer. They are read, never clicked. This bit us too.

6. **`rec.xRaw` vs `rec.x`.** `xRaw` is the log2 fold change as the file reports
   it; `x` is what gets plotted and may carry a centring offset. Statistics and
   exports must be explicit about which they mean.

7. **`state.thresholds.fcCutoff` is in log₂, always** — even though the UI reads
   and writes a linear fold change (2 means two-fold). Convert at the UI edge
   only.

8. **Geometry is in figure coordinates, not screen pixels.** `state.displayScale`
   scales the canvas to fit the stage. Mouse handlers convert via the canvas's
   bounding rect; nothing else should know about the display scale.

9. **Generated files:** `volcano-studio.html` (by `tools/build-single.js`) and
   `data/demo_proteomics.csv` (by `js/demo.js`). Don't edit either by hand.

---

## Working on this safely

**The science is the hard part, not the code.** A volcano plot that renders
beautifully can still be wrong. Before touching anything that affects
classification, fold-change scaling, centring, or p-value handling, read
`docs/DOMAIN.md`. Specifically: the fold-change column in a real vendor file is
often *not* log2, and getting that wrong corrupts the figure silently.

**External services are best-effort.** Every call can fail — offline, rate
limited, CORS-refused, contract changed. The app must stay usable when they do:
say so in plain language and fall back. Never let a failed lookup leave a
spinner, a half-state, or a thrown error at the top level.

**Prefer verifying to assuming.** Much of this app is geometric or numeric, where
"looks right" and "is right" diverge easily. The existing tests assert measured
facts — label boxes don't overlap the legend, grid cells are square to within
0.02 px, the hypergeometric matches exact integer arithmetic. Add tests in that
style rather than visual spot-checks.

**If you find a bug in existing behaviour, say so** rather than quietly coding
around it.
