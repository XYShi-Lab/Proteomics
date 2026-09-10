/* =============================================================================
   data.js - turning a results table into a plottable dataset.

   The awkward part of a volcano-plot tool is not the plot, it is that every
   core facility exports a different table. This module sniffs the delimiter,
   guesses which columns hold the accession / gene / fold change / p-value,
   works out whether the fold-change column is log2, a linear ratio or a
   *signed* fold change, and copes with protein groups ("P1;P2;P3").

   Everything it guesses is surfaced in the UI and can be overridden.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  /* --- delimited text ----------------------------------------------------- */

  function sniffDelimiter(text) {
    const sample = text.slice(0, 64 * 1024).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    const cands = ['\t', ',', ';', '|'];
    let best = '\t', bestScore = -1;
    for (const d of cands) {
      const counts = sample.map((l) => splitLine(l, d).length);
      if (!counts.length) continue;
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      if (mean < 2) continue;
      // Prefer the delimiter that yields the most columns *consistently*.
      const varc = counts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / counts.length;
      const score = mean - varc * 2;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // RFC4180-ish splitter: honours double quotes and escaped quotes.
  function splitLine(line, delim) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === delim) {
        out.push(cur); cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseDelimited(text, delim) {
    text = text.replace(/^\uFEFF/, '');
    const d = delim || sniffDelimiter(text);
    // Join physical lines that are inside a quoted field.
    const raw = text.split(/\r\n|\n|\r/);
    const rows = [];
    let pending = null;
    for (const line of raw) {
      const merged = pending == null ? line : pending + '\n' + line;
      const quotes = (merged.match(/"/g) || []).length;
      if (quotes % 2 === 1) { pending = merged; continue; }
      pending = null;
      if (!merged.trim()) continue;
      rows.push(splitLine(merged, d).map((s) => s.trim()));
    }
    if (pending != null && pending.trim()) rows.push(splitLine(pending, d).map((s) => s.trim()));
    return { rows, delimiter: d };
  }

  /* --- table shaping ------------------------------------------------------ */

  /* Some exports carry a title block above the real header. Find the first row
     that looks like a header: mostly non-empty, mostly non-numeric, and the
     widest row around. */
  function findHeaderRow(rows) {
    const width = rows.slice(0, 40).reduce((m, r) => Math.max(m, r.length), 0);
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = rows[i];
      const filled = r.filter((c) => c !== '' && c != null).length;
      if (filled < 2) continue;
      const numeric = r.filter((c) => c !== '' && isFinite(numify(c))).length;
      const score = filled / width * 10 - numeric * 2 - i * 0.15;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function toTable(rows) {
    if (!rows || !rows.length) return { headers: [], rows: [] };
    const h = findHeaderRow(rows);
    const headersRaw = rows[h] || [];
    const width = Math.max(headersRaw.length, ...rows.slice(h + 1, h + 200).map((r) => r.length), 0);
    const headers = [];
    const seen = Object.create(null);
    for (let i = 0; i < width; i++) {
      let name = String(headersRaw[i] == null ? '' : headersRaw[i]).trim();
      if (!name) name = 'Column ' + (i + 1);
      if (seen[name]) { const n = ++seen[name]; name = name + ' (' + n + ')'; }
      else seen[name] = 1;
      headers.push(name);
    }
    const body = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;
      if (r.every((c) => c === '' || c == null)) continue;
      body.push(r);
    }
    return { headers, rows: body, headerRow: h };
  }

  /* --- numbers ------------------------------------------------------------ */

  // Tolerant numeric coercion: handles "1,23" decimal commas, "1.2E-5",
  // "< 0.001", "1.5e-3 " and Excel's "#N/A" / "NaN" / "-" placeholders.
  function numify(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    let s = String(v).trim();
    if (!s) return NaN;
    if (/^(na|n\/a|#n\/a|nan|null|-|\.|inf|#div\/0!|#value!)$/i.test(s)) return NaN;
    s = s.replace(/^[<>=~]+\s*/, '').replace(/\s/g, '');
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function columnStats(rows, idx) {
    let n = 0, numeric = 0, min = Infinity, max = -Infinity;
    let negatives = 0, absBelowOne = 0, zeros = 0, aboveOne = 0;
    const lim = Math.min(rows.length, 5000);
    for (let i = 0; i < lim; i++) {
      const raw = rows[i][idx];
      if (raw === '' || raw == null) continue;
      n++;
      const v = numify(raw);
      if (!isFinite(v)) continue;
      numeric++;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v < 0) negatives++;
      if (v === 0) zeros++;
      const a = Math.abs(v);
      if (a > 0 && a < 1) absBelowOne++;
      if (a > 1) aboveOne++;
    }
    return {
      n, numeric, min, max, negatives, zeros, absBelowOne, aboveOne,
      numericFrac: n ? numeric / n : 0,
    };
  }

  /* --- column detection --------------------------------------------------- */

  const PATTERNS = {
    id: [
      [/^(majority\s*)?protein\s*(group\s*)?(ids?|accessions?)$/i, 100],
      [/^accessions?$/i, 100],
      [/^(uniprot|entry|protein)\s*(id|accession)?$/i, 90],
      [/uniprot/i, 70],
      [/accession/i, 70],
      [/protein.*\bid\b/i, 65],
      [/\bprotein\b/i, 40],
      [/^id$/i, 35],
    ],
    gene: [
      [/^gene\s*(names?|symbols?|ids?)?$/i, 100],
      [/^genes$/i, 100],
      [/^symbols?$/i, 85],
      [/gene.*(name|symbol)/i, 80],
      [/\bgene\b/i, 55],
    ],
    fc: [
      [/log\s*2.*(fold\s*change|fc|ratio)/i, 100],
      [/^log2fc$/i, 100],
      [/(fold\s*change|foldchange)/i, 80],
      [/^fc$/i, 80],
      [/_fc$/i, 78],
      [/\bratio\b/i, 55],
      [/difference/i, 55],
      [/\blogfc\b/i, 95],
      [/\blfc\b/i, 70],
    ],
    p: [
      [/^p[\s._-]*val(ue)?$/i, 100],
      [/_pval(ue)?$/i, 95],
      [/^p$/i, 70],
      [/p[\s._-]*value/i, 80],
      [/\bpval/i, 70],
      [/significance/i, 40],
    ],
    padj: [
      [/^(adj|adjusted)[\s._-]*p[\s._-]*val(ue)?$/i, 100],
      [/_adjp(val(ue)?)?$/i, 100],
      [/^padj$/i, 100],
      [/\bfdr\b/i, 90],
      [/^q[\s._-]*val(ue)?$/i, 90],
      [/adj.*p.*val/i, 85],
      [/benjamini/i, 85],
      [/\bqval/i, 80],
    ],
    desc: [
      [/^description$/i, 100],
      [/^protein\s*(name|description)s?$/i, 95],
      [/\bdescription\b/i, 70],
      [/protein.*name/i, 60],
    ],
    name: [
      [/^(entry\s*)?names?$/i, 90],
      [/^uniprot.*name$/i, 85],
    ],
  };

  function scoreHeader(header, kind) {
    let best = 0;
    for (const [re, score] of PATTERNS[kind]) {
      if (re.test(header)) best = Math.max(best, score);
    }
    // "adj p-value" / "FDR" must never win the raw p-value slot, and a plain
    // p-value column must never win the adjusted slot.
    if (best > 0 && kind === 'p') {
      let adj = 0;
      for (const [re, score] of PATTERNS.padj) if (re.test(header)) adj = Math.max(adj, score);
      if (adj >= best) return 0;
    }
    return best;
  }

  /* Files often hold several contrasts side by side
     (GEMclear_v_NC_FC / _pval / _adjpval, plus another comparison).
     Group them so the user can switch contrast without re-mapping columns. */
  const SUFFIX_RE = /^(.*?)[\s._-]*(log2fc|log2\s*fold\s*change|logfc|fold\s*change|fc|adj\s*p\s*val(?:ue)?|adjpval(?:ue)?|padj|fdr|q\s*val(?:ue)?|qval(?:ue)?|p\s*val(?:ue)?|pval(?:ue)?|p)$/i;

  function classifySuffix(suffix) {
    const s = suffix.toLowerCase().replace(/[\s._-]/g, '');
    if (/^(adjpval(ue)?|padj|fdr|qval(ue)?)$/.test(s)) return 'padj';
    if (/^(pval(ue)?|p)$/.test(s)) return 'p';
    if (/^(log2fc|log2foldchange|logfc)$/.test(s)) return 'fc';
    if (/^(foldchange|fc)$/.test(s)) return 'fc';
    return null;
  }

  function detectComparisons(headers) {
    const groups = new Map();
    headers.forEach((h, i) => {
      const m = SUFFIX_RE.exec(h.trim());
      if (!m) return;
      const prefix = m[1].replace(/[\s._-]+$/, '').trim();
      if (!prefix) return;
      const kind = classifySuffix(m[2]);
      if (!kind) return;
      if (!groups.has(prefix)) groups.set(prefix, { name: prefix, fc: null, p: null, padj: null });
      const g = groups.get(prefix);
      if (g[kind] == null) g[kind] = i;
    });
    // A real comparison needs at least a fold change and some kind of p-value.
    return Array.from(groups.values()).filter((g) => g.fc != null && (g.p != null || g.padj != null));
  }

  /**
   * Decide how a fold-change column is encoded.
   *
   *  'log2'   already log2 - use as-is.
   *  'linear' a plain ratio (0.02 .. 50) - take log2.
   *  'signed' a signed/reciprocal fold change (-56 .. 97, nothing inside
   *           +/-1) as produced by Proteome Discoverer, Spectronaut and most
   *           CRO reports - take sign(x) * log2(|x|).
   */
  function detectFcScale(header, stats) {
    if (/log\s*2|log2fc|logfc|\blfc\b/i.test(header)) return 'log2';
    if (!stats || !stats.numeric) return 'log2';
    const { negatives, absBelowOne, min, max, numeric } = stats;

    if (negatives === 0 && min > 0) {
      // Strictly positive: a ratio, unless it looks like a log2 column that
      // happens to be all-positive (very narrow range near zero).
      if (max <= 6 && min >= 0 && absBelowOne / numeric > 0.3 && max / Math.max(min, 1e-9) < 50) return 'log2';
      return 'linear';
    }
    // Has negatives. A gap around zero is the signature of a signed fold change.
    if (absBelowOne / numeric < 0.01 && (max > 2 || min < -2)) return 'signed';
    return 'log2';
  }

  function applyFcScale(v, scale) {
    if (!isFinite(v)) return NaN;
    if (scale === 'log2') return v;
    if (scale === 'linear') return v > 0 ? Math.log2(v) : NaN;
    if (scale === 'signed') {
      const a = Math.abs(v);
      if (a < 1) return 0;           // inside the dead band: no change
      return (v < 0 ? -1 : 1) * Math.log2(a);
    }
    return v;
  }

  const FC_SCALE_LABEL = {
    log2: 'already log2',
    linear: 'linear ratio -> log2(x)',
    signed: 'signed fold change -> sign(x)·log2(|x|)',
  };

  function detectMapping(headers, rows) {
    const pick = (kind, exclude) => {
      let best = -1, bestScore = 0;
      headers.forEach((h, i) => {
        if (exclude && exclude.has(i)) return;
        const s = scoreHeader(h, kind);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      return bestScore > 0 ? best : -1;
    };

    // Numeric columns only, for fc / p / padj.
    const numericOk = new Set();
    headers.forEach((h, i) => {
      const st = columnStats(rows, i);
      if (st.numericFrac > 0.7 && st.numeric > 0) numericOk.add(i);
    });
    const pickNumeric = (kind) => {
      let best = -1, bestScore = 0;
      headers.forEach((h, i) => {
        if (!numericOk.has(i)) return;
        const s = scoreHeader(h, kind);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      return bestScore > 0 ? best : -1;
    };

    const comparisons = detectComparisons(headers);
    let fc = -1, p = -1, padj = -1, comparison = null;
    if (comparisons.length) {
      comparison = comparisons[0];
      fc = comparison.fc;
      p = comparison.p != null ? comparison.p : -1;
      padj = comparison.padj != null ? comparison.padj : -1;
    } else {
      fc = pickNumeric('fc');
      padj = pickNumeric('padj');
      p = pickNumeric('p');
      if (p === padj) p = -1;
    }

    const id = pick('id');
    const gene = pick('gene', new Set([id]));
    const desc = pick('desc');
    const name = pick('name', new Set([id, gene, desc].filter((x) => x >= 0)));

    const fcStats = fc >= 0 ? columnStats(rows, fc) : null;
    const fcScale = fc >= 0 ? detectFcScale(headers[fc], fcStats) : 'log2';

    // -log10(p) columns (Perseus) are common; detect and flag.
    let pIsNegLog = false;
    if (p >= 0 && /-?\s*log\s*10/i.test(headers[p])) pIsNegLog = true;
    if (padj >= 0 && /-?\s*log\s*10/i.test(headers[padj])) pIsNegLog = true;

    return {
      id, gene, desc, name, fc, p, padj,
      fcScale, pIsNegLog,
      useAdjusted: padj >= 0,
      comparisons, comparison: comparison ? comparison.name : null,
      fcStats,
    };
  }

  /* --- dataset building --------------------------------------------------- */

  const SPLIT_IDS = /[;,|]\s*/;

  function cleanAccession(a) {
    // "sp|P12345|NAME_HUMAN" -> P12345 ; "P12345-2" -> keep, base tracked too.
    const s = String(a || '').trim();
    const bar = /^[a-z]{2}\|([^|]+)\|/i.exec(s);
    return (bar ? bar[1] : s).trim();
  }

  /**
   * Build the plottable records.
   * @param {{headers:string[],rows:string[][]}} table
   * @param {object} map  column mapping (indices) + fcScale/useAdjusted flags
   */
  function buildDataset(table, map) {
    const { headers, rows } = table;
    const out = [];
    const dropped = { noFc: 0, noP: 0, pOutOfRange: 0 };
    let minPositiveP = Infinity;

    const col = (r, i) => (i >= 0 && i < r.length ? r[i] : '');

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const fcRaw = numify(col(r, map.fc));
      if (!isFinite(fcRaw)) { dropped.noFc++; continue; }

      let p = map.p >= 0 ? numify(col(r, map.p)) : NaN;
      let padj = map.padj >= 0 ? numify(col(r, map.padj)) : NaN;
      if (map.pIsNegLog) {
        if (isFinite(p)) p = Math.pow(10, -p);
        if (isFinite(padj)) padj = Math.pow(10, -padj);
      }
      if (!isFinite(p) && !isFinite(padj)) { dropped.noP++; continue; }
      if ((isFinite(p) && (p < 0 || p > 1.0000001)) || (isFinite(padj) && (padj < 0 || padj > 1.0000001))) {
        dropped.pOutOfRange++;
        continue;
      }
      if (isFinite(p) && p > 0 && p < minPositiveP) minPositiveP = p;
      if (isFinite(padj) && padj > 0 && padj < minPositiveP) minPositiveP = padj;

      const idField = String(col(r, map.id) || '').trim();
      const geneField = String(col(r, map.gene) || '').trim();
      const ids = idField ? idField.split(SPLIT_IDS).map(cleanAccession).filter(Boolean) : [];
      const genes = geneField ? geneField.split(SPLIT_IDS).map((s) => s.trim()).filter(Boolean) : [];

      const rec = {
        i: out.length,
        row: i,
        ids,
        id: ids[0] || '',
        genes,
        gene: genes[0] || '',
        name: String(col(r, map.name) || '').trim(),
        desc: String(col(r, map.desc) || '').trim(),
        fcRaw,
        x: applyFcScale(fcRaw, map.fcScale),
        p: isFinite(p) ? p : null,
        padj: isFinite(padj) ? padj : null,
        raw: r,
      };
      rec.label = rec.gene || rec.id || rec.name || ('row ' + (i + 1));
      if (!isFinite(rec.x)) { dropped.noFc++; continue; }
      out.push(rec);
    }

    // p == 0 cannot be plotted on a -log10 axis. Substitute half the smallest
    // positive p in the file and flag it, rather than silently dropping the
    // most significant hits.
    const floor = isFinite(minPositiveP) ? minPositiveP / 2 : 1e-300;
    let capped = 0;
    for (const rec of out) {
      rec.pCapped = false;
      if (rec.p === 0) { rec.p = floor; rec.pCapped = true; capped++; }
      if (rec.padj === 0) { rec.padj = floor; rec.pCapped = true; }
    }

    return { records: out, dropped, capped, pFloor: floor };
  }

  /** Recompute the y value + significance class for every record. */
  function classify(records, opts) {
    const useAdj = !!opts.useAdjusted;
    const pCut = opts.pCutoff;
    const fcCut = Math.abs(opts.fcCutoff);
    const counts = { up: 0, down: 0, ns: 0 };
    for (const r of records) {
      const pv = useAdj ? (r.padj != null ? r.padj : r.p) : (r.p != null ? r.p : r.padj);
      r.pUsed = pv;
      r.y = pv > 0 ? -Math.log10(pv) : 0;
      const sig = pv != null && pv <= pCut;
      if (sig && r.x >= fcCut && fcCut >= 0 && r.x > 0) { r.cls = 'up'; counts.up++; }
      else if (sig && r.x <= -fcCut && r.x < 0) { r.cls = 'down'; counts.down++; }
      else if (sig && fcCut === 0) { r.cls = r.x >= 0 ? 'up' : 'down'; counts[r.x >= 0 ? 'up' : 'down']++; }
      else { r.cls = 'ns'; counts.ns++; }
    }
    return counts;
  }

  VP.data = {
    sniffDelimiter, splitLine, parseDelimited, toTable, numify, columnStats,
    detectMapping, detectComparisons, detectFcScale, applyFcScale, buildDataset,
    classify, cleanAccession, FC_SCALE_LABEL,
  };
})(window.VP);
