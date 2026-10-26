# Architecture

How the pieces fit. Read `AGENTS.md` first for conventions and invariants.

---

## Shape of the thing

One HTML page, twelve scripts, no framework. Each script is an IIFE publishing to
a global `VP` namespace. `index.html` loads them in dependency order:

```
util → xlsx → data → stats → pngmeta → surface → plot → network → api → demo → app
```

`app.js` is the only module that touches the DOM outside its own widgets, holds
all mutable state, and wires everything together. Every other module is a pure-ish
library with an explicit export block and no knowledge of the app's state object.

```
          ┌──────────┐
 file ───▶│ xlsx.js  │──┐
          └──────────┘  │   ┌──────────┐     ┌──────────┐     ┌─────────────┐
                        ├──▶│ data.js  │────▶│  app.js  │────▶│  plot.js    │
 text ──────────────────┘   └──────────┘     │  (state) │     │  (figure)   │
                                             └────┬─────┘     └──────┬──────┘
                                                  │                  │
                             ┌────────────────────┼──────────┐       ▼
                             ▼                    ▼          ▼  ┌──────────┐
                       ┌──────────┐        ┌───────────┐  ┌────▶│surface.js│
                       │  api.js  │        │ stats.js  │  │     └────┬─────┘
                       │(external)│        │   (ORA)   │  │          │
                       └────┬─────┘        └─────┬─────┘  │     ┌────┴─────┐
                            └────────┬───────────┘        │     ▼          ▼
                                     ▼                    │  canvas      SVG
                              ┌────────────┐              │ (screen,    (vector
                              │ network.js │──────────────┘   PNG)      export)
                              └────────────┘
```

---

## Data flow

### 1. Load → table

A dropped file goes to `app.handleFile()`, which routes by extension:

- `.png` / `.json` → **not data**. These are *format presets*; they go to
  `restoreFromPng()` / `restoreSession()`.
- `.xlsx` / `.xlsm` → `VP.xlsx.read(arrayBuffer)` → `{sheets:[{name, rows}]}`.
  The sheet with the most cells wins by default.
- anything else → `VP.data.parseDelimited(text)` (delimiter sniffed).

Then `VP.data.toTable(rows)` finds the header row — vendor exports routinely put
a title block above it — and returns `{headers, rows}`.

### 2. Table → mapping

`VP.data.detectMapping(headers, rows)` guesses which columns are what, scoring
header names against pattern tables and requiring numeric columns for numeric
roles. It also:

- groups columns into **comparisons** by suffix (`X_FC`, `X_pval`, `X_adjpval`),
  so a file with several contrasts offers a picker;
- infers the **fold-change scale** — see `docs/DOMAIN.md`, this is the one that
  silently ruins figures;
- detects `-log10(p)` columns.

Every guess is surfaced in the UI and overridable. The mapping is just indices.

### 3. Mapping → records

`VP.data.buildDataset(table, mapping)` produces the record array. One record per
plottable protein:

```js
{
  i,            // index into state.records — the identity used everywhere
  row,          // source row index
  ids, id,      // all accessions in the protein group; id is the first
  genes, gene,  // all gene symbols; gene is the first
  name, desc,   // entry name, description (from the file)
  fcRaw,        // fold change exactly as the file wrote it
  xRaw,         // log2 fold change, scale-corrected   ← statistics
  x,            // what gets plotted (xRaw minus any centring offset)  ← drawing
  p, padj,      // raw and adjusted p, or null
  raw,          // the original row, for CSV export
}
```

Rows with no usable fold change or no p-value are dropped and counted.
`p === 0` is floored at half the smallest positive p in the file and flagged,
rather than dropping the most significant hits.

### 4. Records → classification

`VP.data.classify(records, {useAdjusted, pCutoff, fcCutoff})` runs on every
threshold change and writes onto each record:

- `pUsed` — raw or adjusted p, per the toggle
- `y` — `-log10(pUsed)`
- `cls` — `'up' | 'down' | 'ns'`

and returns the counts. `fcCutoff` is in **log₂**.

### 5. Records → figure

`app.renderNow()` each frame:

1. compute `displayScale` so the figure fills the stage
2. size the canvas (CSS size × devicePixelRatio × displayScale)
3. `VP.plot.draw(surface, state)` → returns the geometry
4. `VP.plot.buildIndex(state, geom)` → spatial hash for hit testing

Rendering is `requestAnimationFrame`-coalesced via `render()`.

---

## The drawing surface

`surface.js` is the load-bearing abstraction. It exposes one API —
`rect, line, polyline, markers, text, clip, group` — with two back ends:

- **canvas** — the screen, and PNG export at any scale factor
- **svg** — vector export, emitting grouped, named layers

`plot.draw()` makes identical calls to either. That is the only reason the
exported figure matches the screen; a second rendering path would drift within a
week. Text baselines are resolved to explicit `dy` offsets in both back ends so
glyphs land on the same pixel.

`markers()` takes a *bucket* of identically-styled points and draws them in one
path (canvas) or one `<g>` (SVG). Point drawing buckets by
`priority|colour|shape|radius|opacity|stroke` — that is what keeps a
10,000-protein volcano interactive while panning, and what keeps the SVG small.

---

## The figure (`plot.js`)

`computeGeometry(state)` is the heart. It:

1. resolves the domain (data extent, symmetric-x, manual overrides, zoom view)
2. generates ticks — user interval if given and sane, else nice 1-2-5 ticks
3. measures tick labels to size the left margin
4. **reserves margin** for every legend that is not allowed to overlap the plot
5. optionally shrinks and centres the plot rectangle to make grid cells square
6. returns scales (`sx`, `sy`, `ix`, `iy`) and the plot rectangle

Everything downstream — axes, marks, legends, label layout, hit testing — works
from that one object.

**Draw order** is deliberate: grid → threshold lines → points → labels (clipped
to the axes) → axes → legends. Labels sit under the axes so they can never
overdraw the frame.

**Label placement** is three-tier. Pass 1 tries 8 directions × 4 rings avoiding
every other label and the legends. Pass 2 widens to 16 directions × 8 rings and
accepts overlapping another label but never a legend (legends are opaque; a label
under one is erased). Pass 3 clamps inside the axes and nudges clear of reserved
boxes. Labels are placed most-significant-first so crowded plots give the good
positions to the names that matter. Manual drags are stored as offsets in
`state.labelOffsets` keyed by record index.

**Two legends**, formatted independently: the up/down/n.s. key (`config.legend`)
and the cluster legend (`config.clusterLegend`). Each can be inside, outside
(reserving margin) or floating. Both are draggable: grabbing either one switches
it to floating.

---

## Clusters

A cluster is a named gene set overlaid on the plot:

```js
{ id, name, genes:Set, accessions:Set, color, shape, visible, muted,
  selected, source, total, matched, up, down, termId? }
```

`app.applyClusters()` resolves membership in two passes — **muted first, then
visible** — so an explicit overlay always beats a greyed-out set. A muted
cluster's members get `rec.muted = true` and are drawn exactly like
non-significant dots; their classification is untouched.

Colour *and* marker shape vary together, so overlays survive greyscale printing
and colour-blind readers. Colour is never the only encoding.

---

## Enrichment and the network

`stats.overRepresentation()` is a one-sided hypergeometric test with
Benjamini-Hochberg FDR, run against any loaded gene-set library. It needs no
server. `api.gprofiler()` and `api.enrichr()` are the online alternatives; all
three normalise to the same row shape so the table and network don't care which
produced them.

`network.js` turns those rows into an **enrichment map**: nodes are terms (sized
by hit count, coloured to match the volcano), edges are Jaccard overlap of the
gene sets above a threshold. Layout is Fruchterman-Reingold with a repulsion
cutoff — without the cutoff, disconnected themes fly apart into distant islands.
It is computed locally from gene lists the enrichment already returned, so it
works offline.

One colour per term is assigned by `app.assignEnrichColors()` and shared by three
views at once: the table swatch, the network node, and the volcano cluster. A
term already on the plot keeps the colour it has there.

---

## Format persistence

`app.sessionData()` serialises cutoffs, centring, config, clusters and the
protein list — everything except the data. It goes out two ways:

- as JSON (`Save format`)
- embedded in every exported PNG as an uncompressed `iTXt` chunk
  (`pngmeta.embed`), so a figure carries the settings that made it

Both come back through `restoreSession()`. Older format files are migrated by
filling missing config blocks from `plot.defaultConfig()`.

---

## State

All mutable state is one object in `app.js` (`VP.state`, exposed for debugging
and for the tests). Notable fields:

| field | meaning |
|---|---|
| `records` | the plottable dataset |
| `thresholds` | `{pCutoff, fcCutoff (log2!), useAdjusted}` |
| `centre` / `centreOffset` | global-shift correction |
| `config` | everything about how the figure looks; this is what gets saved |
| `clusters` | the overlays |
| `pinned` / `listMatched` | record indices carrying labels |
| `labelOffsets` | manual label positions |
| `view` | zoom domain, or null for auto |
| `geom` / `index` | last render's geometry and hit-test index |
| `lookup` | name → record indices, for matching pasted lists |
| `enrich` / `net` | enrichment results and network view |

There is no reactive system. Mutate state, then call `recompute()` (classification
changed) or `render()` (appearance only). `recompute()` calls `render()`.

**Label history** (`pushLabelHistory`, `undoLabels`, `redoLabels`) snapshots only
the labelling slice of state. Drags snapshot at grab time so one gesture is one
undo step.
