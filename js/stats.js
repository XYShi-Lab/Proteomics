/* =============================================================================
   stats.js - over-representation analysis, computed in the browser.

   Used two ways: as the engine behind "Built-in" pathway analysis (works with
   no enrichment server at all, over any gene-set library the app has loaded),
   and as the fallback when g:Profiler / Enrichr cannot be reached.

   The test is the standard one-sided Fisher / hypergeometric over-representation
   test, with Benjamini-Hochberg FDR control across the terms tested.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  /* --- log-gamma (Lanczos) ------------------------------------------------ */

  const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  function logGamma(z) {
    if (z < 0.5) {
      // Reflection formula keeps precision for small z.
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
    const t = z + LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  const logFact = (n) => logGamma(n + 1);

  // log C(n, k)
  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    return logFact(n) - logFact(k) - logFact(n - k);
  }

  /**
   * One-sided hypergeometric tail: P(X >= k).
   *
   *   N  population size (background)
   *   K  successes in population (genes annotated to the term)
   *   n  sample size (query genes present in the background)
   *   k  observed successes (query genes in the term)
   */
  function hypergeomTail(k, n, K, N) {
    if (k <= 0) return 1;
    if (K <= 0 || n <= 0 || N <= 0) return 1;
    if (k > K || k > n) return 0;
    const maxK = Math.min(n, K);
    const logDen = logChoose(N, n);
    // Sum from the far tail inwards - the terms shrink, so precision holds.
    let sum = 0;
    for (let i = maxK; i >= k; i--) {
      const lp = logChoose(K, i) + logChoose(N - K, n - i) - logDen;
      sum += Math.exp(lp);
    }
    return Math.min(1, Math.max(0, sum));
  }

  /** Benjamini-Hochberg FDR. Returns adjusted p-values in the input order. */
  function benjaminiHochberg(pvals) {
    const m = pvals.length;
    const idx = pvals.map((p, i) => i).sort((a, b) => pvals[a] - pvals[b]);
    const adj = new Array(m);
    let prev = 1;
    for (let rank = m - 1; rank >= 0; rank--) {
      const i = idx[rank];
      const v = Math.min(prev, (pvals[i] * m) / (rank + 1));
      adj[i] = Math.min(1, v);
      prev = adj[i];
    }
    return adj;
  }

  /**
   * Over-representation analysis of `query` against a gene-set library.
   *
   * @param {string[]} query      query gene symbols (already upper-cased)
   * @param {Array<{term:string,id?:string,genes:Set<string>}>} library
   * @param {object} opts  { background: string[]|null, minSize, maxSize, pCutoff }
   */
  function overRepresentation(query, library, opts) {
    opts = opts || {};
    const minSize = opts.minSize == null ? 5 : opts.minSize;
    const maxSize = opts.maxSize == null ? 2000 : opts.maxSize;

    // The background defaults to the union of the library's own genes - the
    // "annotated genes only" domain, which is what g:Profiler calls
    // domain_scope=annotated and is the sane default when the user has not
    // supplied their own measured proteome.
    let bg = null;
    if (opts.background && opts.background.length) {
      bg = new Set(opts.background);
    } else {
      bg = new Set();
      for (const t of library) for (const g of t.genes) bg.add(g);
    }
    const N = bg.size;

    const q = [];
    const qSeen = new Set();
    for (const g of query) {
      if (!g || qSeen.has(g)) continue;
      qSeen.add(g);
      if (bg.has(g)) q.push(g);
    }
    const n = q.length;
    const qSet = new Set(q);

    const rows = [];
    for (const term of library) {
      // Restrict the term to the background, so K and N describe the same universe.
      let K = 0;
      const hits = [];
      for (const g of term.genes) {
        if (!bg.has(g)) continue;
        K++;
        if (qSet.has(g)) hits.push(g);
      }
      if (K < minSize || K > maxSize) continue;
      const k = hits.length;
      if (k === 0) continue;
      const p = hypergeomTail(k, n, K, N);
      rows.push({
        id: term.id || term.term,
        name: term.term,
        source: term.source || 'library',
        p_value: p,
        term_size: K,
        query_size: n,
        intersection_size: k,
        background_size: N,
        // Fold enrichment: observed rate vs. expected rate.
        fold_enrichment: n > 0 && K > 0 ? (k / n) / (K / N) : 0,
        genes: hits.sort(),
      });
    }

    const adj = benjaminiHochberg(rows.map((r) => r.p_value));
    rows.forEach((r, i) => { r.p_adjusted = adj[i]; });
    rows.sort((a, b) => a.p_value - b.p_value || b.intersection_size - a.intersection_size);
    return { results: rows, queryMapped: n, queryTotal: qSeen.size, background: N };
  }

  VP.stats = { logGamma, logChoose, hypergeomTail, benjaminiHochberg, overRepresentation };
})(window.VP);
