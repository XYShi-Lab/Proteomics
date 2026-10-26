# Tests

```bash
node tests/run.mjs            # headless
node tests/run.mjs --headed   # watch it
```

Needs Playwright with Chromium:

```bash
npm install          # dev-only; the app itself has no dependencies
npx playwright install chromium
```

## What it does

`run.mjs` is self-contained. It starts its own static server on a free port,
launches Chromium, and **blocks every outbound host** — so the offline and
degraded paths are exercised on every run, not just the happy path. The two
Enrichr endpoints are stubbed with a small GMT library so the real
download → parse → enrich → table → network chain still executes.

56 checks, grouped:

| Group | What it pins down |
|---|---|
| pure functions | hypergeometric vs exact integer arithmetic; BH; fold-change scale detection and conversion |
| load and classify | the example dataset parses, classifies, builds geometry and a hit index, and actually paints |
| cutoffs | the UI takes a fold change while state keeps log₂; stricter cutoffs call fewer proteins |
| protein list matching | separators, and that misses are reported |
| clusters | membership counts, per-cluster up/down, greying out |
| figure geometry | outside legends never overlap the plot; labels stay inside the axes and clear of legends; the square-grid lock holds across frame shapes |
| export | SVG is valid XML with named layers; transient hover chrome never reaches an export; settings round-trip through a PNG chunk |
| enrichment and network | the offline engine works with no enrichment server; nested terms produce edges; one colour is shared by table, network and plot; labelling is undoable |
| degraded paths | a blocked service throws a typed error with a readable message |

It also fails on **any** uncaught page error.

## Writing more

Assert measured facts, not appearances. Much of this app is geometric or
numeric, where "looks right" and "is right" come apart easily — so the existing
checks compare label bounding boxes, grid cell dimensions to within 0.02 px, and
p-values against values computed by exact integer arithmetic.

Where an invariant is upheld by a specific function, **test through that
function**. The export-chrome check drives the real download button rather than
calling `plot.draw()`, because clearing the hover flag is the export's job, not
the renderer's — testing the renderer directly asserts a contract that was never
promised, and fails for the wrong reason.
