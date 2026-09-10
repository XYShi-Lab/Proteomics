# Shi Lab Volcano & GO

Interactive volcano plots for proteomics, in the browser. Drop in a results
table, set your cutoffs, hover a dot to find out what the protein is and where
it lives, label the proteins you care about, overlay organelles and pathways,
run enrichment, and export a publication-ready figure.

The figure is always scaled to fill the stage, so changing the frame size,
opening the results drawer or switching panels never leaves the plot stranded in
a corner — the canvas backing store is scaled with it, so it stays crisp.

Everything runs client-side. **Your data is never uploaded.** Only gene and
protein *names* leave the browser, and only when you ask for annotation or
enrichment.

---

## Running it

**Option 1 — one file.** Download **`volcano-studio.html`** and double-click it.
The whole app is inside that single file: no checkout, no server, nothing else
to keep next to it. Easy to email to a collaborator or keep on a USB stick.

**Option 2 — the repository.** Double-click `index.html`. Identical app, split
into readable source files. (Loading `.xlsx` needs a current Chrome, Edge,
Firefox or Safari — see [Browser support](#browser-support).)

**Option 3 — GitHub Pages.** Enable Pages for this repository on the branch you
want, and the site is served from the repository root. (Pages on a *private*
repository needs a paid GitHub plan.)

**Option 4 — a local server**, if you prefer one:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Click **Load example dataset** to explore without your own data.

---

## What it does

### 1. Load a results table

Drop in `.xlsx`, `.csv`, `.tsv` or `.txt`. The app sniffs the delimiter, finds
the header row even when the export has a title block above it, picks the right
worksheet in a multi-sheet workbook, and guesses which columns hold the
accession, gene, fold change and p-values. Every guess is shown and can be
overridden under **Column mapping**.

It handles the things that actually turn up in vendor reports:

| Situation | What happens |
|---|---|
| Protein groups (`P1;P2;P3`) | All accessions kept and matchable; the first is the primary |
| `sp\|P12345\|NAME_HUMAN` | Unwrapped to `P12345` |
| Isoform suffixes (`P12345-2`) | Matched against the base accession too |
| Several contrasts in one file | A **Comparison** picker appears |
| `p = 0` | Floored at half the smallest positive p in the file, and flagged |
| `-log10(p)` columns (Perseus) | Detected and inverted |
| Decimal commas, `#N/A`, `< 0.001` | Parsed tolerantly |

**Fold-change encoding is auto-detected**, which matters more than it sounds:

- `log2` — already log2, used as-is.
- `linear` — a ratio like `0.02 … 50`, converted with `log2(x)`.
- `signed` — a signed fold change like `-56 … +97` with nothing between −1 and
  +1, as produced by Proteome Discoverer, Spectronaut and most core facilities.
  Converted with `sign(x) · log2(|x|)`.

Getting this wrong silently corrupts a volcano plot, so the detected reading is
always displayed and always overridable.

**Global-shift detection.** Quantitative proteomics assumes most proteins do not
change, so the bulk of a volcano should straddle zero. When it does not — say
95% of proteins move the same way with a median log₂FC of +0.79 — the two
conditions differ by a global scale factor (unequal loading, or normalisation
that left an offset), and measuring every protein against zero measures that
offset rather than biology. The app detects this on load, says so in plain
language, and offers **Centring**: subtract the median (or a 10% trimmed mean)
so enrichment is judged against the bulk of the proteome instead of against
zero. The uncentred value stays visible in the hover card, both values are
exported, and the x-axis label records that the figure is centred — a reader
cannot interpret the zero otherwise.

### 2. Hover for protein identity, location and function

Parking the cursor on a dot shows the gene name, every accession in the group,
the entry name, log₂FC, raw and adjusted p — plus:

- **Location** — subcellular localisation from UniProt.
- **Pathway** — the UniProt pathway comment, or pathway memberships from a
  loaded gene-set library.
- **Function** — a short functional summary from UniProt, falling back to the
  description column in your own file.

Lookups are debounced, cached in `localStorage`, and done by accession — or by
gene symbol when your table has no accession column. If UniProt is unreachable
the card quietly falls back to what your file and any loaded library already
know, rather than hanging.

### 3. Label a list of proteins

Paste gene symbols or accessions — one per line, or separated by commas,
semicolons or spaces. Matches are labelled and ringed; anything not found is
reported back explicitly so a typo or an ID-type mismatch never passes
unnoticed. You can also:

- **Click** any point to pin or unpin its label.
- **Drag** a label to place it; double-click to snap it back.
- **Box-label** a whole region (shift-drag, or the *Box label* tool). In that
  mode a single click labels the point under the cursor; a double-click on any
  labelled point removes its label.
- **Auto-label** the top *N* proteins by significance.
- **Remove all labels** in one click, with **undo/redo** (buttons, or
  Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z) across every labelling action — pinning,
  box-select, pasted lists, auto-labels and hand-placed label positions.

Labels avoid each other and the legend, with leader lines when they sit away
from their point.

### 4. Adjustable cutoffs

p-value and fold-change cutoffs are live: sliders, exact numeric entry, and
one-click presets (1.5×, 2×, 4×). The fold-change cutoff is entered as a **fold
change** — 2 means two-fold — because that is how it gets reported; the log₂
equivalent is shown underneath. Up/down/n.s. counts update as you move them,
and you can switch between the raw and adjusted p-value at any time — the
y-axis label follows. If adjusted p leaves you with almost nothing (common with
few replicates), the app says so instead of showing an empty plot.

### 5. Style controls

Font family (publication faces: Arial, Helvetica, Arial Narrow, Calibri, Times,
Georgia…), independent sizes for tick labels, axis titles, point labels and the
plot title, bold/italic labels (point labels can take a font of their own, set in the Label
panel), point size, opacity, outline width, per-class
colours, background, grid, axis style, figure dimensions, and three preset
palettes including a colour-blind-safe one. Every colour control offers both a
free gradient picker and a grid of 32 print-safe presets.

**Axes.** x and y ranges and tick intervals can each be set by hand or left to
work themselves out — clearing one box returns just that edge to automatic. y
min starts at −0.1 so proteins sitting on p = 1 are not clipped by the axis
line. **Auto** clears everything back to defaults and **Undo auto** puts your
manual settings back. A
tick interval too fine for the range is refused rather than drawing hundreds of
lines, and the status bar says what it used instead.

**Lock square grid** keeps one x tick interval exactly the same size on the page
as one y tick interval, whatever the figure dimensions. The domains and tick
steps stay as you set them, so the plot rectangle is what gives: it shrinks on
one axis and the figure letterboxes around it. Verified square at frame shapes
from 500×900 to 1400×400.

The legend sits **to the right of the plot by default**, in reserved margin, so
it never covers data. It can also go in any corner, or float freely — and you
move it by simply **dragging it**: grab the box anywhere on the figure and it
becomes floating, following the mouse. Hovering it shows a grip outline (screen
only; it never appears in an export). Automatic labels route around whichever
position it occupies.

### 6. GO clusters — organelles and pathways

Search a compartment or pathway and every matching protein in your data is
recoloured **and reshaped** (colour alone is never the encoding, so overlays
survive greyscale printing and colour-blind readers). Two sources:

- **Gene-set library** — one download gives every term in a library with its
  full gene list, so searching afterwards is instant and works offline.
  Libraries come from Enrichr (GO Cellular Component, Jensen COMPARTMENTS,
  CORUM, GO BP/MF, KEGG, Reactome, WikiPathways, Hallmark, and any other
  Enrichr library by name).
- **UniProt GO (live)** — search the Gene Ontology directly and pull the term's
  members for your organism from UniProt. Because UniProt's `go:` search
  includes descendant terms, asking for *mitochondrion* also returns its
  sub-compartments, which is what you want for an organelle overlay.

You can also paste a custom gene list as a cluster.

**Grouping.** Related terms are usually redundant — *mitochondrion*,
*mitochondrial matrix* and *mitochondrial inner membrane* are largely the same
proteins. Tick two or more clusters and press **Group** to merge them into a
single entry: the union of their genes, under one name, one colour, one marker
shape and one legend row. Cluster names are editable in place, and **Add all as
one** takes every hit a search returned in a single click.

**Outlines.** A dot outline (width and colour) can be applied to every point
from either the GO panel or the Style panel — the two controls drive the same
setting.

**Cluster legend.** Clusters get their own legend, formatted independently of
the up/down/n.s. key. Place it as its **own panel** to the right, left, above or
below the plot — the figure reserves margin so it can never overlap the data —
or as an **inset box** in any corner, or dragged freely. Its font, label size,
title, column count and box dimensions are all set separately, and each row can
report the cluster's hits among the **significant up** set, the **significant
down** set, and the **whole dataset** (`↑93 ↓1 n=144`). Those tallies follow
your cutoffs live.

### 7. Pathway analysis

Over-representation analysis on your up, down, all-significant, labelled or
clustered proteins, with three engines:

| Engine | Where it runs | Notes |
|---|---|---|
| **g:Profiler** | server | Multi-source (GO, KEGG, Reactome, WikiPathways, CORUM, TF), g:SCS multiple-testing correction |
| **Enrichr** | server | One library at a time |
| **Built-in** | **your browser** | Hypergeometric test + Benjamini–Hochberg FDR over any loaded library. Needs no enrichment server. |

Results land in a two-column view on a **white background** — this is figure
material, so it is presented the way it would be published: a sortable,
filterable table on the left, and a **pathway network** on the right.

Pick how many top terms to work with (default 6). Each gets its own colour, and
that one colour is used everywhere: the swatch in the table, the node in the
network, and the cluster on the volcano plot. A term already overlaid on the
volcano keeps the colour it has there; anything new takes the next free slot in
the cluster palette. Clicking a term to annotate it carries the same colour
across.

The network is an enrichment map. Enrichment output is a ranked list, but its
terms are not independent — nested GO terms report the same proteins several
times over. Drawing each term as a node and joining terms that share genes
collapses that redundancy into visible themes. Nodes are sized by hit count and
coloured by source (GO:BP, GO:CC, KEGG, Reactome…); edge thickness is the
Jaccard overlap of the two gene sets, with an adjustable threshold. Scroll to
zoom, drag to pan, double-click a node to zoom into it, double-click the
background to fit, and export the network as its own PNG.

**Click any row's *annotate* button, or any node in the network, to paint that
term's genes straight onto the volcano plot.** The network is computed locally
from gene lists the enrichment already returned, so it needs no extra service
and works with the offline engine.

By default the background is *the proteins actually measured in your file*,
which is the statistically correct choice for a proteomics experiment — using
"all annotated genes" inflates significance because your instrument never had a
chance to detect most of them.

### 8. Export

- **PNG** at 1×/2×/4×/8× (4× ≈ 300 dpi).
- **SVG** — true vector, with points, labels, axes and legend as separate named
  layers, and each series (up, down, n.s., every cluster) as its own selectable
  group in Illustrator, Inkscape or Affinity.
- **CSV** — all proteins with classification, significant only, or the
  enrichment table.
- **Format JSON** — cutoffs, centring, styling, labels, clusters and legends, so
  one look can be reused across experiments. Apply a saved format with **Load
  JSON to preset format** (or **Load PNG to preset format**) in the Data panel.
- **Settings inside the PNG.** Every exported PNG carries its own settings in an
  iTXt chunk. Drop that PNG back onto the app — or hand it to a colleague — and
  the entire format is restored: cutoffs, centring, fonts, colours, labels,
  clusters and legend placement. It stays an ordinary image everywhere else.

The PNG and SVG are generated from the same draw calls that paint the screen,
so the exported figure is exactly the figure you were looking at.

---

## Browser support

Reading `.xlsx` uses the browser's native `DecompressionStream`, which needs
Chrome/Edge 80+, Firefox 113+ or Safari 16.4+. Everything else works further
back, and `.csv`/`.tsv` always work. If a workbook cannot be read the app says
so and points you at CSV.

Opening `index.html` straight from disk works. Note that from a `file://` page
some services may refuse the cross-origin request; if annotation or enrichment
fails that way, serve the folder over `http://` (see above) or use GitHub Pages.

---

## External services

| Service | Used for | If it is unavailable |
|---|---|---|
| [UniProt](https://www.uniprot.org/) | Hover-card annotation, GO term members | Hover falls back to your file's own description and loaded libraries |
| [Enrichr](https://maayanlab.cloud/Enrichr/) | Gene-set libraries, enrichment | Use g:Profiler, or a library already loaded this session |
| [g:Profiler](https://biit.cs.ut.ee/gprofiler/) | Enrichment | Use the built-in engine |
| [QuickGO](https://www.ebi.ac.uk/QuickGO/) / [EBI OLS](https://www.ebi.ac.uk/ols4/) / [GO API](https://api.geneontology.org/) | GO term name search | Three are tried in turn; libraries need none of them |

No service is required for the plot itself, cutoffs, labelling, styling or
export. Failures are reported in plain language and never leave the app in a
broken state.

Please cite these resources if their results appear in your paper.

---

## Project layout

```
index.html              markup and controls
css/styles.css          all styling
js/util.js              formatting, DOM and colour helpers
js/xlsx.js              dependency-free .xlsx reader (ZIP + DecompressionStream)
js/data.js              parsing, column detection, fold-change scale inference
js/stats.js             hypergeometric test + Benjamini-Hochberg FDR
js/surface.js           one drawing API with canvas and SVG back ends
js/plot.js              the volcano figure: scales, marks, legend, label layout
js/api.js               UniProt, Enrichr, g:Profiler, QuickGO/OLS/GO clients
js/network.js           the enrichment-map pathway network
js/pngmeta.js           reading and writing settings inside a PNG
js/demo.js              simulated example dataset
js/app.js               state, wiring, interaction
data/demo_proteomics.csv  the example dataset as a file
tools/build-single.js   bundles all of the above into one .html file
volcano-studio.html     the single-file build (generated - do not edit by hand)
```

No build step, no package manager, no third-party runtime dependencies. The
files under `css/` and `js/` are the source of truth; after changing them,
regenerate the single-file build with:

```bash
node tools/build-single.js
```

---

## The example dataset

`data/demo_proteomics.csv` is **simulated**, but built from real human gene
symbols grouped by genuine compartment, so GO overlays and enrichment return
meaningful results on it. It models an organelle-enrichment experiment:
mitochondrial and centrosomal proteins go up, ribosomal and nucleolar proteins
go down. Fold changes are written as *signed* fold changes so the example
exercises the same parsing path as a real vendor report.

It is not experimental data and should not be used as such.
