/* =============================================================================
   api.js - the outside world: GO / pathway databases and protein annotation.

   Everything here is best-effort. Public bioinformatics services go down, get
   rate-limited, or block a browser origin; when that happens the app says so
   and falls back rather than breaking. Three independent routes are used:

     * Enrichr gene-set libraries (GMT text) - one fetch gives every term in a
       library with its full gene list, which powers BOTH organelle/pathway
       annotation and the built-in enrichment test, and keeps working offline
       once loaded.
     * UniProt REST - per-protein annotation for the hover card, and live GO
       term membership when a library is not enough.
     * g:Profiler / Enrichr - server-side enrichment when available.

   All responses are parsed defensively: these are third-party contracts that
   change without notice.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const ENRICHR = 'https://maayanlab.cloud/Enrichr';
  const UNIPROT = 'https://rest.uniprot.org';
  const GPROFILER = 'https://biit.cs.ut.ee/gprofiler/api';
  const QUICKGO = 'https://www.ebi.ac.uk/QuickGO/services';

  /* --- organisms ---------------------------------------------------------- */

  const ORGANISMS = [
    { id: 'hsapiens', label: 'Human (H. sapiens)', taxon: 9606 },
    { id: 'mmusculus', label: 'Mouse (M. musculus)', taxon: 10090 },
    { id: 'rnorvegicus', label: 'Rat (R. norvegicus)', taxon: 10116 },
    { id: 'drerio', label: 'Zebrafish (D. rerio)', taxon: 7955 },
    { id: 'dmelanogaster', label: 'Fly (D. melanogaster)', taxon: 7227 },
    { id: 'celegans', label: 'Worm (C. elegans)', taxon: 6239 },
    { id: 'scerevisiae', label: 'Yeast (S. cerevisiae)', taxon: 559292 },
    { id: 'athaliana', label: 'Arabidopsis (A. thaliana)', taxon: 3702 },
    { id: 'sscrofa', label: 'Pig (S. scrofa)', taxon: 9823 },
    { id: 'btaurus', label: 'Cow (B. taurus)', taxon: 9913 },
    { id: 'ggallus', label: 'Chicken (G. gallus)', taxon: 9031 },
    { id: 'xtropicalis', label: 'Frog (X. tropicalis)', taxon: 8364 },
  ];

  /* Curated starting point for the library picker. The live list from
     Enrichr replaces this when it can be reached. */
  const CURATED_LIBRARIES = [
    { name: 'GO_Cellular_Component_2023', group: 'Organelles & compartments' },
    { name: 'Jensen_COMPARTMENTS', group: 'Organelles & compartments' },
    { name: 'CORUM', group: 'Organelles & compartments' },
    { name: 'GO_Biological_Process_2023', group: 'Processes & pathways' },
    { name: 'GO_Molecular_Function_2023', group: 'Processes & pathways' },
    { name: 'KEGG_2021_Human', group: 'Processes & pathways' },
    { name: 'Reactome_2022', group: 'Processes & pathways' },
    { name: 'WikiPathway_2023_Human', group: 'Processes & pathways' },
    { name: 'MSigDB_Hallmark_2020', group: 'Processes & pathways' },
    { name: 'HumanCyc_2016', group: 'Processes & pathways' },
  ];

  /* --- fetch plumbing ----------------------------------------------------- */

  class ApiError extends Error {
    constructor(message, kind, status) {
      super(message);
      this.kind = kind;       // 'network' | 'http' | 'parse' | 'abort'
      this.status = status;
    }
  }

  function describeFailure(url, err) {
    const host = (/^https?:\/\/([^/]+)/.exec(url) || [, url])[1];
    if (err && err.name === 'AbortError') {
      return new ApiError('Timed out contacting ' + host + '.', 'abort');
    }
    // A browser-side CORS/network failure gives a bare TypeError with no detail.
    return new ApiError(
      'Could not reach ' + host + '. It may be offline, blocked by your network, ' +
      'or refusing cross-origin requests from this page.', 'network'
    );
  }

  async function request(url, opts) {
    opts = opts || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 45000);
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctrl.signal,
        mode: 'cors',
        credentials: 'omit',
      });
    } catch (err) {
      clearTimeout(timer);
      throw describeFailure(url, err);
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new ApiError(
        (/^https?:\/\/([^/]+)/.exec(url) || [, url])[1] + ' returned HTTP ' + res.status +
        (res.status === 400 ? ' (the request was rejected - the service may have changed its fields).' : '.'),
        'http', res.status
      );
    }
    return res;
  }

  const getText = async (url, opts) => (await request(url, opts)).text();
  const getJson = async (url, opts) => {
    const txt = await (await request(url, opts)).text();
    try { return JSON.parse(txt); }
    catch (e) { throw new ApiError('Unreadable response from ' + url.slice(0, 60) + '...', 'parse'); }
  };

  /* --- small persistent cache -------------------------------------------- */

  const mem = new Map();
  const LS_KEY = 'vp.cache.v1';
  let lsCache = null;

  function lsRead() {
    if (lsCache) return lsCache;
    try { lsCache = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (e) { lsCache = {}; }
    return lsCache;
  }
  function lsWrite() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(lsCache)); }
    catch (e) {
      // Quota exceeded - annotations are a convenience, so drop them silently.
      lsCache = {};
      try { localStorage.removeItem(LS_KEY); } catch (e2) { /* ignore */ }
    }
  }

  function cacheGet(key, persistent) {
    if (mem.has(key)) return mem.get(key);
    if (persistent) {
      const v = lsRead()[key];
      if (v !== undefined) { mem.set(key, v); return v; }
    }
    return undefined;
  }
  function cacheSet(key, value, persistent) {
    mem.set(key, value);
    if (persistent) { lsRead()[key] = value; lsWrite(); }
  }
  function clearCache() {
    mem.clear();
    lsCache = {};
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  /* --- gene-set libraries (GMT) ------------------------------------------ */

  function parseGmt(text, libName) {
    const out = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      const parts = line.split('\t');
      const term = parts[0].trim();
      if (!term) continue;
      const genes = new Set();
      // Column 2 is the GMT description field (Enrichr leaves it blank).
      for (let i = 2; i < parts.length; i++) {
        let g = parts[i].trim();
        if (!g) continue;
        // Enrichr weights genes as "GENE,1.0" in some libraries.
        const comma = g.indexOf(',');
        if (comma > 0) g = g.slice(0, comma);
        g = g.toUpperCase();
        if (g) genes.add(g);
      }
      if (genes.size) out.push({ term, id: term, genes, source: libName });
    }
    return out;
  }

  const libraries = new Map();   // name -> {terms, loadedAt}
  const inflight = new Map();

  function libraryLoaded(name) { return libraries.has(name); }
  function getLibrary(name) { return libraries.get(name) || null; }
  function loadedLibraryNames() { return Array.from(libraries.keys()); }

  async function loadLibrary(name, onProgress) {
    if (libraries.has(name)) return libraries.get(name);
    if (inflight.has(name)) return inflight.get(name);

    const p = (async () => {
      const url = ENRICHR + '/geneSetLibrary?mode=text&libraryName=' + encodeURIComponent(name);
      if (onProgress) onProgress({ phase: 'download', name });
      const text = await getText(url, { timeout: 120000 });
      if (!text || text.length < 20 || /^\s*</.test(text)) {
        throw new ApiError('Enrichr returned no data for library "' + name + '". Check the library name.', 'parse');
      }
      if (onProgress) onProgress({ phase: 'parse', name, bytes: text.length });
      const terms = parseGmt(text, name);
      if (!terms.length) throw new ApiError('Library "' + name + '" contained no gene sets.', 'parse');
      const lib = { name, terms, bytes: text.length, loadedAt: Date.now() };
      libraries.set(name, lib);
      inflight.delete(name);
      return lib;
    })();

    inflight.set(name, p);
    p.catch(() => inflight.delete(name));
    return p;
  }

  /** Full library list, live from Enrichr, falling back to the curated set. */
  async function listLibraries() {
    const cached = cacheGet('enrichr.libs', false);
    if (cached) return cached;
    try {
      const j = await getJson(ENRICHR + '/datasetStatistics', { timeout: 20000 });
      const stats = (j && j.statistics) || [];
      const list = stats
        .filter((s) => s && s.libraryName)
        .map((s) => ({
          name: s.libraryName,
          terms: s.numTerms || s.numberOfTerms || 0,
          coverage: s.geneCoverage || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (list.length) { cacheSet('enrichr.libs', list, false); return list; }
    } catch (e) { /* fall through to curated */ }
    return CURATED_LIBRARIES.map((l) => ({ name: l.name, terms: 0, coverage: 0 }));
  }

  /** Substring / regex search over the terms of an already-loaded library. */
  function searchLibrary(libName, query, limit) {
    const lib = libraries.get(libName);
    if (!lib) return [];
    const q = String(query || '').trim();
    if (!q) return lib.terms.slice(0, limit || 50);
    let re = null;
    try { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { return []; }
    const hits = [];
    for (const t of lib.terms) {
      if (re.test(t.term)) hits.push(t);
      if (hits.length >= (limit || 200)) break;
    }
    // Shorter names first: "Mitochondrion" should outrank
    // "Mitochondrion-associated adherens complex".
    hits.sort((a, b) => a.term.length - b.term.length);
    return hits;
  }

  /* --- GO term search (live) --------------------------------------------- */

  const GO_ID_RE = /^GO:?\s*(\d{7})$/i;

  /**
   * Search the Gene Ontology by name. Tries QuickGO, then EBI OLS, then the
   * GO API - any one of them being reachable is enough.
   */
  async function searchGoTerms(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 25;
    const q = String(query || '').trim();
    if (!q) return [];

    const idm = GO_ID_RE.exec(q.replace(/\s/g, ''));
    if (idm) {
      const id = 'GO:' + idm[1];
      try {
        const j = await getJson(QUICKGO + '/ontology/go/terms/' + encodeURIComponent(id), { timeout: 15000 });
        const r = (j.results || [])[0];
        if (r) return [{ id: r.id, name: r.name, aspect: r.aspect, source: 'QuickGO' }];
      } catch (e) { /* ignore */ }
      return [{ id, name: id, aspect: null, source: 'id' }];
    }

    const key = 'go.search.' + q.toLowerCase() + '.' + limit;
    const hit = cacheGet(key, true);
    if (hit) return hit;

    const attempts = [
      async () => {
        const j = await getJson(QUICKGO + '/ontology/go/search?query=' + encodeURIComponent(q) +
          '&limit=' + limit + '&page=1', { timeout: 20000 });
        return (j.results || []).map((r) => ({
          id: r.id, name: r.name, aspect: r.aspect, source: 'QuickGO',
        }));
      },
      async () => {
        const j = await getJson('https://www.ebi.ac.uk/ols4/api/search?q=' + encodeURIComponent(q) +
          '&ontology=go&rows=' + limit, { timeout: 20000 });
        const docs = (j.response && j.response.docs) || [];
        return docs.map((d) => ({
          id: d.obo_id || d.short_form || d.id,
          name: d.label,
          aspect: d.ontology_prefix,
          source: 'EBI OLS',
        }));
      },
      async () => {
        const j = await getJson('https://api.geneontology.org/api/search/entity/autocomplete/' +
          encodeURIComponent(q) + '?category=ontology_class&prefix=GO&rows=' + limit, { timeout: 20000 });
        const docs = (j.docs) || [];
        return docs.map((d) => ({
          id: d.id, name: Array.isArray(d.label) ? d.label[0] : d.label,
          aspect: null, source: 'GO API',
        }));
      },
    ];

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const res = (await attempt()).filter((r) => r.id && /^GO:/i.test(r.id));
        if (res.length) { cacheSet(key, res, true); return res; }
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  /**
   * Members of a GO term, from UniProt. UniProt's `go:` query includes child
   * terms, so asking for "mitochondrion" also returns everything annotated to
   * its sub-compartments - which is what you want for an organelle overlay.
   */
  async function fetchGoMembers(goId, taxon, opts) {
    opts = opts || {};
    const reviewed = opts.reviewed !== false;
    const key = 'go.members.' + goId + '.' + taxon + '.' + (reviewed ? 'sp' : 'all');
    const cached = cacheGet(key, false);
    if (cached) return cached;

    const bare = String(goId).replace(/^GO:?/i, '');
    const parts = ['(go:' + bare + ')'];
    if (taxon) parts.push('(organism_id:' + taxon + ')');
    if (reviewed) parts.push('(reviewed:true)');
    const query = encodeURIComponent(parts.join(' AND '));
    const fields = 'accession,gene_primary,gene_names';

    let text;
    try {
      // /stream returns the whole result set with no paging to chase.
      text = await getText(UNIPROT + '/uniprotkb/stream?query=' + query +
        '&fields=' + fields + '&format=tsv', { timeout: 90000 });
    } catch (e) {
      text = await getText(UNIPROT + '/uniprotkb/search?query=' + query +
        '&fields=' + fields + '&format=tsv&size=500', { timeout: 60000 });
    }

    const lines = text.split('\n');
    const accessions = new Set(), genes = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (!cols[0]) continue;
      accessions.add(cols[0].trim().toUpperCase());
      const primary = (cols[1] || '').trim();
      if (primary) genes.add(primary.toUpperCase());
      for (const g of (cols[2] || '').split(/\s+/)) {
        if (g) genes.add(g.trim().toUpperCase());
      }
    }
    const res = { accessions, genes, n: accessions.size, source: 'UniProt' };
    cacheSet(key, res, false);
    return res;
  }

  /* --- per-protein annotation (hover card) -------------------------------- */

  // UniProt comment lines carry evidence tags; strip them for display.
  function cleanComment(s, prefix) {
    if (!s) return '';
    let t = String(s);
    t = t.replace(/\{[^{}]*\}/g, ' ');
    if (prefix) t = t.replace(new RegExp('^\\s*' + prefix + ':\\s*', 'i'), '');
    t = t.replace(new RegExp('\\b' + (prefix || 'FUNCTION') + ':\\s*', 'gi'), ' ');
    t = t.replace(/\[Isoform [^\]]*\]:\s*/gi, '');
    t = t.replace(/\s+/g, ' ').replace(/\s+([.;,])/g, '$1');
    // Removing an evidence tag can leave "oxidation.. Involved" - collapse it.
    t = t.replace(/\.(\s*\.)+/g, '.').replace(/\s+/g, ' ').trim();
    return t;
  }

  function firstSentences(s, n) {
    if (!s) return '';
    // Split after a full stop without lookbehind, which older Safari cannot parse.
    const parts = s.replace(/\.\s+/g, '.\u0000').split('\u0000');
    if (parts.length <= 1) return s;
    return parts.slice(0, n || 2).join(' ').trim();
  }

  function parseLocations(s) {
    let t = cleanComment(s, 'SUBCELLULAR LOCATION');
    t = t.replace(/Note=.*$/i, '');
    const out = [];
    const seen = new Set();
    for (let piece of t.split(/[.;]/)) {
      piece = piece.replace(/^\s*(Isoform[^:]*:)?\s*/i, '').trim();
      // Drop qualifiers like "Single-pass membrane protein" topology notes.
      if (!piece || piece.length > 70) continue;
      const k = piece.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(piece);
      if (out.length >= 6) break;
    }
    return out;
  }

  const FIELD_SETS = [
    'accession,id,protein_name,gene_primary,cc_function,cc_subcellular_location,cc_pathway',
    'accession,protein_name,cc_function,cc_subcellular_location',
  ];

  /**
   * Batch-fetch annotation for UniProt accessions.
   * @returns {Promise<Map<string, object>>} keyed by upper-case accession
   */
  async function fetchAnnotations(accessions) {
    const want = [];
    const out = new Map();
    for (const a of accessions) {
      const acc = String(a || '').trim().toUpperCase();
      if (!acc) continue;
      const c = cacheGet('ann.' + acc, true);
      if (c !== undefined) { out.set(acc, c); continue; }
      if (!want.includes(acc)) want.push(acc);
    }
    if (!want.length) return out;

    for (let i = 0; i < want.length; i += 90) {
      const chunk = want.slice(i, i + 90);
      const q = encodeURIComponent(chunk.map((a) => 'accession:' + a).join(' OR '));
      let text = null, lastErr = null;
      for (const fields of FIELD_SETS) {
        try {
          text = await getText(UNIPROT + '/uniprotkb/search?query=' + q + '&fields=' + fields +
            '&format=tsv&size=500', { timeout: 30000 });
          break;
        } catch (e) { lastErr = e; }
      }
      if (text == null) throw lastErr || new ApiError('UniProt lookup failed.', 'network');

      const lines = text.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      const head = lines[0].split('\t').map((h) => h.trim().toLowerCase());
      const col = (...names) => {
        for (const nm of names) {
          const i2 = head.findIndex((h) => h === nm || h.indexOf(nm) === 0);
          if (i2 >= 0) return i2;
        }
        return -1;
      };
      const cAcc = col('entry', 'accession');
      const cName = col('protein names', 'protein name');
      const cGene = col('gene names (primary)', 'gene names');
      const cFunc = col('function [cc]');
      const cLoc = col('subcellular location [cc]');
      const cPath = col('pathway');

      const found = new Set();
      for (let li = 1; li < lines.length; li++) {
        const cols = lines[li].split('\t');
        const acc = (cols[cAcc] || '').trim().toUpperCase();
        if (!acc) continue;
        const rec = {
          accession: acc,
          proteinName: (cols[cName] || '').trim(),
          gene: (cols[cGene] || '').trim(),
          function: firstSentences(cleanComment(cols[cFunc], 'FUNCTION'), 2),
          locations: parseLocations(cols[cLoc]),
          pathway: cleanComment(cols[cPath], 'PATHWAY'),
          fetchedAt: Date.now(),
        };
        out.set(acc, rec);
        cacheSet('ann.' + acc, rec, true);
        found.add(acc);
      }
      // Remember misses too, so a dead accession is not re-requested on every hover.
      for (const acc of chunk) {
        if (!found.has(acc)) {
          const miss = { accession: acc, missing: true };
          out.set(acc, miss);
          cacheSet('ann.' + acc, miss, true);
        }
      }
    }
    return out;
  }

  /**
   * Annotation by gene symbol, for result tables that carry no accession
   * column - which is most of them, once a facility has collapsed protein
   * groups to gene names.
   */
  async function fetchAnnotationByGene(gene, taxon) {
    const g = String(gene || '').trim().toUpperCase();
    if (!g) return null;
    const key = 'anng.' + g + '.' + (taxon || 0);
    const cached = cacheGet(key, true);
    if (cached !== undefined) return cached;

    const parts = ['(gene:' + g + ')'];
    if (taxon) parts.push('(organism_id:' + taxon + ')');
    parts.push('(reviewed:true)');
    const q = encodeURIComponent(parts.join(' AND '));

    let text = null, lastErr = null;
    for (const fields of FIELD_SETS) {
      try {
        text = await getText(UNIPROT + '/uniprotkb/search?query=' + q + '&fields=' + fields +
          '&format=tsv&size=1', { timeout: 25000 });
        break;
      } catch (e) { lastErr = e; }
    }
    if (text == null) throw lastErr || new ApiError('UniProt lookup failed.', 'network');

    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
      const miss = { gene: g, missing: true };
      cacheSet(key, miss, true);
      return miss;
    }
    const head = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const col = (...names) => {
      for (const nm of names) {
        const i = head.findIndex((h) => h === nm || h.indexOf(nm) === 0);
        if (i >= 0) return i;
      }
      return -1;
    };
    const cols = lines[1].split('\t');
    const rec = {
      accession: (cols[col('entry', 'accession')] || '').trim(),
      proteinName: (cols[col('protein names', 'protein name')] || '').trim(),
      gene: g,
      function: firstSentences(cleanComment(cols[col('function [cc]')], 'FUNCTION'), 2),
      locations: parseLocations(cols[col('subcellular location [cc]')]),
      pathway: cleanComment(cols[col('pathway')], 'PATHWAY'),
      fetchedAt: Date.now(),
    };
    cacheSet(key, rec, true);
    return rec;
  }

  /* --- enrichment --------------------------------------------------------- */

  const GPROFILER_SOURCES = ['GO:BP', 'GO:CC', 'GO:MF', 'KEGG', 'REAC', 'WP', 'TF', 'CORUM', 'HP'];

  /** g:Profiler g:GOSt. Returns rows in the app's common shape. */
  async function gprofiler(genes, opts) {
    opts = opts || {};
    const body = {
      organism: opts.organism || 'hsapiens',
      query: genes,
      sources: opts.sources && opts.sources.length ? opts.sources : ['GO:BP', 'GO:CC', 'GO:MF', 'KEGG', 'REAC', 'WP'],
      user_threshold: opts.pCutoff == null ? 0.05 : opts.pCutoff,
      significance_threshold_method: opts.method || 'g_SCS',
      all_results: false,
      ordered: !!opts.ordered,
      no_evidences: false,
domain_scope: opts.background && opts.background.length ? 'custom' : 'annotated',
    };
    if (opts.background && opts.background.length) body.background = opts.background;

    const j = await getJson(GPROFILER + '/gost/profile/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 90000,
    });

    const rows = (j && j.result) || [];
    // Recover the intersecting genes: `intersections` is index-aligned with
    // meta.genes_metadata.query.<name>.ensgs, and `mapping` takes each input
    // symbol to its Ensembl id(s).
    let ensgs = null, ensgToInput = null;
    try {
      const qmeta = j.meta.genes_metadata.query;
      const first = qmeta[Object.keys(qmeta)[0]];
      ensgs = first.ensgs || null;
      ensgToInput = new Map();
      const mapping = first.mapping || {};
      for (const input in mapping) {
        for (const e of mapping[input]) ensgToInput.set(e, input);
      }
    } catch (e) { ensgs = null; }

    return {
      provider: 'g:Profiler',
      results: rows.map((r) => {
        let genesOut = [];
        if (ensgs && Array.isArray(r.intersections)) {
          for (let i = 0; i < r.intersections.length && i < ensgs.length; i++) {
            const ev = r.intersections[i];
            if (ev && ev.length) {
              const e = ensgs[i];
              genesOut.push((ensgToInput && ensgToInput.get(e)) || e);
            }
          }
        }
        return {
          id: r.native,
          name: r.name,
          source: r.source,
          p_value: r.p_value,
          p_adjusted: r.p_value,     // g:Profiler p-values are already corrected
          term_size: r.term_size,
          query_size: r.query_size,
          intersection_size: r.intersection_size,
          background_size: r.effective_domain_size,
          fold_enrichment: r.term_size && r.query_size && r.effective_domain_size
            ? (r.intersection_size / r.query_size) / (r.term_size / r.effective_domain_size)
            : 0,
          genes: genesOut,
        };
      }),
    };
  }

  /** Enrichr: post the list, then read one library's results. */
  async function enrichr(genes, libraryName) {
    const fd = new FormData();
    fd.append('list', genes.join('\n'));
    fd.append('description', 'Volcano Studio');
    const add = await getJson(ENRICHR + '/addList', { method: 'POST', body: fd, timeout: 60000 });
    const listId = add && (add.userListId || add.userlistId);
    if (!listId) throw new ApiError('Enrichr did not return a list id.', 'parse');

    const j = await getJson(ENRICHR + '/enrich?userListId=' + encodeURIComponent(listId) +
      '&backgroundType=' + encodeURIComponent(libraryName), { timeout: 90000 });
    const rows = (j && j[libraryName]) || [];
    return {
      provider: 'Enrichr',
      shortId: add.shortId,
      results: rows.map((r) => ({
        // [rank, term, p, zscore, combined, [genes], adjP, oldP, oldAdjP]
        id: r[1], name: r[1], source: libraryName,
        p_value: r[2],
        p_adjusted: r[6] != null ? r[6] : r[2],
        combined_score: r[4],
        term_size: null,
        query_size: genes.length,
        intersection_size: Array.isArray(r[5]) ? r[5].length : 0,
        background_size: null,
        fold_enrichment: 0,
        genes: Array.isArray(r[5]) ? r[5].slice() : [],
      })),
    };
  }

  VP.api = {
    ORGANISMS, CURATED_LIBRARIES, GPROFILER_SOURCES, ApiError,
    request, getText, getJson,
    loadLibrary, listLibraries, searchLibrary, libraryLoaded, getLibrary,
    loadedLibraryNames, parseGmt,
    searchGoTerms, fetchGoMembers, fetchAnnotations, fetchAnnotationByGene,
    gprofiler, enrichr,
    clearCache, cacheGet, cacheSet,
    cleanComment, parseLocations, firstSentences,
  };
})(window.VP);
