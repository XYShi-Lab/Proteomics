# Domain background

What you need to know about proteomics to change this code without quietly
breaking the science. A volcano plot that renders beautifully can still be wrong.

---

## What a volcano plot is

Each point is one protein from a two-condition comparison.

- **x** = log₂ fold change. 0 = no change, +1 = doubled, −1 = halved.
- **y** = −log₁₀ p-value. Higher = more statistically confident.

So the interesting proteins are top-left (confidently down) and top-right
(confidently up), and the uninteresting bulk piles up at the bottom centre. The
characteristic "volcano" silhouette is just that pile with two plumes.

A protein is called significant when it passes **both** a p-value cutoff and a
fold-change cutoff. Requiring both is the convention because a tiny change can be
statistically rock-solid and biologically meaningless, and a huge change can be
one noisy replicate.

---

## The fold-change column is the biggest trap

Vendor exports write fold change in **three mutually incompatible ways**, and
they rarely say which. Reading one as another silently produces a wrong figure
that looks completely normal.

| Encoding | Looks like | Convert with |
|---|---|---|
| **log2** | `-5.8 … +6.6`, dense near 0 | use as-is |
| **linear ratio** | `0.02 … 50`, all positive, dense near 1 | `log2(x)` |
| **signed fold change** | `-56 … +97`, **nothing between −1 and +1** | `sign(x)·log2(|x|)` |

**Signed fold change** is the one that catches people. Proteome Discoverer,
Spectronaut and most core-facility reports use it: a 3-fold increase is `3`, a
3-fold decrease is `-3` (not `0.33`). The giveaway is the **gap around zero** —
no values in (−1, +1), because a ratio of 1 means no change and there is nothing
between "no change" and "1-fold in either direction".

`data.detectFcScale()` discriminates on exactly that gap. If `|values| < 1` is
essentially empty and there are negatives, it's signed. If everything is positive
and spans below and above 1, it's a ratio. Otherwise log2.

The detected reading is **always displayed and always overridable** in the UI.
Keep it that way. Silently guessing here is how you publish a wrong figure.

---

## Raw vs adjusted p-values

Testing 8,000 proteins at p ≤ 0.05 gives you ~400 false positives by chance
alone. Adjusted p-values (FDR, Benjamini-Hochberg) correct for that.

Adjusted is the statistically defensible default, and that's what the app uses
when the column exists. But with few replicates adjusted p is often brutal —
one real dataset here has **1 protein** passing adjusted p ≤ 0.05 and **1,169**
passing raw p ≤ 0.05. Both numbers are "correct"; which to use is the
experimenter's call, not the tool's.

So: default to adjusted, make the toggle prominent, and **say something** when
adjusted leaves almost nothing rather than showing an empty plot. The app does
this. Don't remove it.

The y-axis label must track the toggle (`−log₁₀ p-value` vs
`−log₁₀ adjusted p-value`). A reader cannot interpret the axis otherwise.

`p = 0` happens (underflow in the vendor's stats). It can't be plotted on a log
axis. We floor it at half the smallest positive p in the file and flag it, rather
than dropping the most significant hits.

---

## The global-shift problem

Quantitative proteomics rests on an assumption: **most proteins don't change.**
So the bulk of a volcano should straddle zero.

When it doesn't — when 95% of proteins move the same direction — the two
conditions differ by a global scale factor. Unequal protein loading, or a
normalisation step that left an offset. Measured against zero, that offset
*is* what you're measuring, and ordinary proteins look regulated.

A real example from this repo's history: a dataset where 95.7% of 7,620 proteins
moved positive, median log₂FC `+0.79` (≈1.7×), with 99.2% of proteins detected in
both conditions. Plotted against zero, **25 of 85 cytosolic ribosomal proteins
scored "up"** — purely by riding the offset. Centring on the median dropped the
"up" calls from 1,169 to 292, took those ribosomal false positives to zero, and
left mitochondrial markers still enriched at median `+0.89`. The real signal
survived; the offset didn't.

`data.shiftDiagnostic()` flags this when `|median| ≥ 0.25` and ≥70% of proteins
move one way. `data.applyCentering()` subtracts the median or a 10% trimmed mean.

Three rules this imposes, all currently honoured:

1. **Centring is off by default.** Whether a global shift is an artefact or the
   point of the experiment (an enrichment vs a negative control, say) is the
   experimenter's call.
2. **The uncentred value stays visible** — in the hover card, and as its own
   column in CSV exports alongside the plotted value and the offset.
3. **The x-axis label says so** (`log₂ fold change (median-centred)`). A reader
   cannot interpret the zero of a centred figure otherwise.

---

## Protein identifiers are messy

A single row can carry several proteins, because mass spectrometry often cannot
distinguish them:

- **Protein groups** — `P12345;Q67890;A0A123` in one cell. All of them must be
  matchable; the first is the primary for display.
- **FASTA wrappers** — `sp|P12345|NAME_HUMAN`. Unwrap to `P12345`.
- **Isoforms** — `P12345-2`. Must also match the base accession `P12345`.
- **Gene symbols** — often several per row, semicolon-separated.
- **Entry names** — `TOM22_HUMAN`; strip `_HUMAN` to match `TOM22`.

`app.buildLookup()` indexes all of these forms so a pasted list matches whichever
the user has. When someone pastes 200 identifiers, the ones that *don't* match
matter as much as the ones that do — a silent 40% miss rate from an ID-type
mismatch is worse than useless. Always report the misses.

---

## GO terms and enrichment

**Gene Ontology** terms describe where a protein is (cellular component —
mitochondrion, ribosome) and what it does (biological process, molecular
function). They are **nested**: `mitochondrial matrix` is inside `mitochondrion`.

Two consequences:

1. Asking a database for "mitochondrion" should return its sub-compartments too.
   UniProt's `go:` search does this (ancestor closure), which is why it's used.
2. Enrichment output is **highly redundant** — `mitochondrion`,
   `mitochondrial matrix` and `oxidative phosphorylation` are largely the same
   proteins reported three times. That redundancy is why the pathway network
   exists: drawing terms as nodes and shared genes as edges collapses it into
   visible themes. (This is the "enrichment map" idea, as in Cytoscape.)

**Over-representation analysis** asks: are the proteins I found enriched for some
term more than chance would give? It's a hypergeometric test — exactly the
urn problem. `stats.hypergeomTail(k, n, K, N)` is verified against exact integer
arithmetic to <10⁻⁶ relative error.

**The background matters enormously.** The default here is *the proteins actually
measured in this file*, not "all annotated genes". Using all annotated genes
inflates significance badly, because the instrument never had a chance to detect
most of them — you end up "discovering" that your mass spec found proteins that
mass specs can find. Keep the measured-proteome default.

---

## Figures are the product

The user's output is a figure going into a manuscript. That shapes several
choices:

- **White background, black text, publication fonts** (Arial, Helvetica, Times…)
  — the app shell is dark, the figure never is.
- **SVG export must be genuinely editable** — named layers, each series its own
  group, so it opens sanely in Illustrator.
- **Colour is never the only encoding.** Clusters vary colour *and* marker shape,
  so overlays survive greyscale printing and colour-blind readers.
- **Nothing transient may appear in an export** — no hover states, no selection
  outlines, no UI chrome.
- **The axes must be self-describing.** If the data was centred, or adjusted
  p-values were used, the axis labels say so. Someone reading the figure without
  the app has to be able to interpret it.
