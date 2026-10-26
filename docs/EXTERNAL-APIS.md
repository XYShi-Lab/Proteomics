# External services

Four public bioinformatics services. All optional — the plot, cutoffs,
labelling, styling and export work with no network at all.

> **These contracts were coded from published documentation and have not all been
> exercised against the live services from the build environment** (its egress
> policy blocks them). Parsing is deliberately defensive. If you are fixing a
> breakage here, first check whether the service changed its response shape
> rather than assuming the code was always wrong.

---

## Rules for anything that talks to the outside

1. **Nothing is required.** A failure degrades one feature; it never blocks the
   app or leaves a half-state.
2. **Say what happened in plain language.** `describeFailure()` distinguishes a
   timeout from a refused origin from an HTTP error, because the user's fix
   differs. Never surface a bare `TypeError`.
3. **A browser CORS failure is indistinguishable from offline** — `fetch` throws
   a bare `TypeError` with no detail. Say "could not reach X; it may be offline,
   blocked by your network, or refusing cross-origin requests from this page."
4. **Cache.** In-memory always; `localStorage` for small per-protein annotations
   (wrapped in try/catch — quota and private mode both throw). Gene-set libraries
   are megabytes and stay in memory only.
5. **Debounce user-driven lookups.** Hovering sweeps across hundreds of points;
   only the one the cursor settles on gets a request.
6. **Record the misses.** A dead accession is cached as `{missing:true}` so it is
   not re-requested on every hover.

---

## UniProt — `rest.uniprot.org`

Protein annotation for the hover card, and GO term membership.

**Why TSV, not JSON:** `&format=tsv` returns flat columns that are trivial and
stable to parse. The JSON is deeply nested and changes shape more often. Columns
are located by **header name, not position**.

```
GET /uniprotkb/search?query=accession:P12345&fields=…&format=tsv&size=500
GET /uniprotkb/search?query=(gene:TOMM22) AND (organism_id:9606) AND (reviewed:true)&…
GET /uniprotkb/stream?query=(go:0005739) AND (organism_id:9606) AND (reviewed:true)&…
```

- Annotation is fetched **by accession**, or **by gene symbol** when the file has
  no accession column (common once a facility collapses protein groups).
- `/stream` returns the whole result set with no paging to chase; `/search` with
  `size=500` is the fallback.
- `go:` searches include descendant terms, which is what you want for an
  organelle overlay (see `docs/DOMAIN.md`).
- Two field sets are tried in order; a 400 on the richer one falls back to the
  minimal one, because an unrecognised field rejects the whole request.

**Free-text comments need cleaning.** UniProt embeds evidence tags:

```
FUNCTION: Catalyzes the NAD(+)-dependent oxidation. {ECO:0000269|PubMed:12882974}. Involved in …
```

`cleanComment()` strips `{ECO:…}`, the field prefix, and `[Isoform N]:` markers —
then collapses the doubled full stop that removing a tag leaves behind. That last
step is easy to drop and produces `oxidation.. Involved`.

---

## Enrichr — `maayanlab.cloud/Enrichr`

Gene-set libraries, and one of the enrichment engines.

```
GET  /geneSetLibrary?mode=text&libraryName=GO_Cellular_Component_2023   → GMT text
GET  /datasetStatistics                                                → library list
POST /addList          (FormData: list, description)                   → {userListId}
GET  /enrich?userListId=…&backgroundType=<library>                     → {<library>: [[…]]}
```

**The GMT endpoint is the useful one.** One fetch returns *every* term in a
library with its full gene list, which powers three things at once: GO/organelle
overlay search, the offline enrichment engine, and the hover card's compartment
lookup. Once loaded it all works offline. Format is
`TermName \t description \t GENE1 \t GENE2 …`; some libraries weight genes as
`GENE,1.0`, so the comma is stripped.

Library names go stale (`KEGG_2021_Human` → whatever is current). The list is
fetched live from `datasetStatistics` and falls back to a curated static list.

The `/enrich` response is positional arrays:
`[rank, term, p, zscore, combinedScore, [genes], adjP, …]`.

---

## g:Profiler — `biit.cs.ut.ee/gprofiler/api`

Multi-source enrichment with g:SCS correction. `POST /gost/profile/` with JSON.

Recovering **which genes** hit a term is the fiddly part. `result[i].intersections`
is index-aligned with `meta.genes_metadata.query.<name>.ensgs`, and `mapping`
takes each input symbol to its Ensembl ids. Non-empty evidence at index `i` means
the gene at `ensgs[i]` is in the intersection; it is then mapped back to the
user's own symbol. Requires `no_evidences: false`. The decode is wrapped — if the
shape changes, rows still render, just without gene lists.

`domain_scope` is `'custom'` with an explicit background when the user supplies
the measured proteome, else `'annotated'`.

---

## GO term search — three providers, tried in order

Name → GO id. Any one being reachable is enough:

1. **QuickGO** `www.ebi.ac.uk/QuickGO/services/ontology/go/search`
2. **EBI OLS4** `www.ebi.ac.uk/ols4/api/search?ontology=go`
3. **GO API** `api.geneontology.org/api/search/entity/autocomplete`

A typed GO id (`GO:0005739`) short-circuits all three. Results cache to
`localStorage`. If the user has loaded a gene-set library, term search runs
against that locally and needs none of these.

---

## Offline fallbacks — what still works with no network

| Feature | Online | Offline |
|---|---|---|
| Plot, cutoffs, labels, style, export | — | **everything** |
| Hover: location / pathway | UniProt | terms from a loaded library, else the file's own description column |
| GO / organelle overlay | UniProt or library | library, once downloaded |
| Pathway enrichment | g:Profiler, Enrichr | **built-in hypergeometric**, over any loaded library |
| Pathway network | — | **always local** — computed from gene lists the enrichment already returned |

The built-in engine (`stats.overRepresentation`) is the reason enrichment is
never truly blocked: given one GMT download, everything else runs in the browser.
