# Volcano Studio

Interactive volcano plots for proteomics, in the browser. Drop in a results
table, set your cutoffs, hover a dot to find out what the protein is and where
it lives, label the proteins you care about, overlay organelles and pathways,
run enrichment, and export a publication-ready figure.

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
- **Box-label** a whole region (shift-drag, or the *Box label* tool).
- **Auto-label** the top *N* proteins by significance.

Labels avoid each other and the legend, with leader lines when they sit away
from their point.

### 4. Adjustable cutoffs

p-value and |log₂ FC| cutoffs are live: sliders, exact numeric entry, and
one-click presets (1.5×, 2×, 4×). Up/down/n.s. counts update as you move them,
and you can switch between the raw and adjusted p-value at any time — the
y-axis label follows. If adjusted p leaves you with almost nothing (common with
few replicates), the app says so instead of showing an empty plot.

### 5. Style controls

Font family (publication faces: Arial, Helvetica, Arial Narrow, Calibri, Times,
Georgia…), independent sizes for tick labels, axis titles, point labels and the
plot title, bold/italic labels, point size, opacity, outline width, per-class
colours, background, grid, legend position, axis style, figure dimensions, and
three preset palettes including a colour-blind-safe one.

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

### 7. Pathway analysis

Over-representation analysis on your up, down, all-significant, labelled or
clustered proteins, with three engines:

| Engine | Where it runs | Notes |
|---|---|---|
| **g:Profiler** | server | Multi-source (GO, KEGG, Reactome, WikiPathways, CORUM, TF), g:SCS multiple-testing correction |
| **Enrichr** | server | One library at a time |
| **Built-in** | **your browser** | Hypergeometric test + Benjamini–Hochberg FDR over any loaded library. Needs no enrichment server. |

Results land in a sortable, filterable table with p-adjusted, hit count, term
size and fold enrichment. **Click *annotate* on any row to paint that term's
genes straight onto the volcano plot.**

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
- **Settings JSON** — cutoffs, styling, labels and clusters, so one look can be
  reused across experiments.

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
