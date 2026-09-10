/* =============================================================================
   app.js - state, wiring and interaction.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const U = VP.util;
  const { $, el, clear, fmtNum, fmtP, clamp, debounce } = U;

  /* Cluster styling: colour AND shape change together, so overlays stay
     separable in greyscale, in print, and for colour-blind readers. */
  const CLUSTER_STYLES = [
    { color: '#1baf7a', shape: 'square' },
    { color: '#4a3aa7', shape: 'triangle' },
    { color: '#eb6834', shape: 'diamond' },
    { color: '#e87ba4', shape: 'triangle-down' },
    { color: '#eda100', shape: 'cross' },
    { color: '#008300', shape: 'circle' },
    { color: '#00868b', shape: 'square' },
    { color: '#8a4b9e', shape: 'triangle' },
  ];

  const PALETTES = {
    default: { up: '#e34948', down: '#2a78d6', ns: '#b9b9b3', highlight: '#111111', grid: '#e9e9e4' },
    colorblind: { up: '#d55e00', down: '#0072b2', ns: '#bcbcb6', highlight: '#000000', grid: '#e9e9e4' },
    mono: { up: '#2b2b2b', down: '#8e8e8e', ns: '#d8d8d4', highlight: '#000000', grid: '#ededea' },
  };

  const state = {
    workbook: null,
    table: null,
    mapping: null,
    dataset: null,
    records: [],
    counts: { up: 0, down: 0, ns: 0 },
    thresholds: { pCutoff: 0.05, fcCutoff: 1, useAdjusted: true },
    config: VP.plot.defaultConfig(),
    clusters: [],
    labelOffsets: {},
    pinned: new Set(),
    listMatched: new Set(),
    autoLabelN: 0,
    labelTextMode: 'gene',
    view: null,
    geom: null,
    index: null,
    lookup: null,
    organism: 'hsapiens',
    mode: 'pan',
    enrich: { results: [], provider: '', sortKey: 'p_adjusted', sortDir: 'asc', filter: '', annotated: new Set() },
    sourceName: '',
  };
  VP.state = state;

  /* ======================= toasts & status ======================= */

  function toast(msg, kind, title) {
    const box = $('#toasts');
    const t = el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, [
      title ? el('b', { text: title }) : null,
      el('span', { text: msg }),
    ]);
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, kind === 'error' ? 8000 : 4200);
  }

  const setStatus = (s) => { $('#stageStatus').textContent = s; };

  function notice(id, html, kind) {
    const n = $('#' + id);
    if (!html) { n.hidden = true; return; }
    n.hidden = false;
    n.className = 'notice' + (kind ? ' ' + kind : '');
    n.innerHTML = html;
  }

  /* ======================= rendering ======================= */

  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderNow(); });
  }

  function renderNow() {
    const cfg = state.config;
    const canvas = $('#plot');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (canvas.width !== Math.round(cfg.width * dpr) || canvas.height !== Math.round(cfg.height * dpr)) {
      canvas.width = Math.round(cfg.width * dpr);
      canvas.height = Math.round(cfg.height * dpr);
    }
    canvas.style.width = cfg.width + 'px';
    canvas.style.height = cfg.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.records.length) { state.geom = null; state.index = null; return; }

    const surface = VP.surface.canvas(ctx, dpr);
    state.geom = VP.plot.draw(surface, state);
    state.index = VP.plot.buildIndex(state, state.geom);
  }

  /* ======================= data loading ======================= */

  function optionList(sel, headers, chosen, allowNone) {
    clear(sel);
    if (allowNone) sel.appendChild(el('option', { value: '-1', text: '— none —' }));
    headers.forEach((h, i) => {
      sel.appendChild(el('option', { value: String(i), text: h }));
    });
    sel.value = String(chosen == null ? -1 : chosen);
  }

  function fillMappingUI() {
    const t = state.table, m = state.mapping;
    if (!t) return;
    optionList($('#colId'), t.headers, m.id, true);
    optionList($('#colGene'), t.headers, m.gene, true);
    optionList($('#colFc'), t.headers, m.fc, false);
    optionList($('#colP'), t.headers, m.p, true);
    optionList($('#colPadj'), t.headers, m.padj, true);
    optionList($('#colDesc'), t.headers, m.desc, true);
    optionList($('#colName'), t.headers, m.name, true);
    $('#colFcScale').value = m.fcScale;
    $('#chkNegLog').checked = !!m.pIsNegLog;
    $('#mappingBlock').hidden = false;

    const stats = m.fc >= 0 ? VP.data.columnStats(t.rows, m.fc) : null;
    let guess = 'Detected automatically — check and adjust if needed.';
    if (stats && isFinite(stats.min)) {
      guess = '<b>' + U.escapeHtml(t.headers[m.fc]) + '</b> ranges ' + fmtNum(stats.min, 2) +
        ' to ' + fmtNum(stats.max, 2) + ', read as <code>' +
        VP.data.FC_SCALE_LABEL[m.fcScale] + '</code>.';
    }
    $('#mapGuess').innerHTML = guess;

    // Comparison switcher, when the file holds several contrasts.
    const comps = m.comparisons || [];
    const field = $('#comparisonField');
    if (comps.length > 1) {
      field.hidden = false;
      const sel = $('#selComparison');
      clear(sel);
      comps.forEach((c, i) => sel.appendChild(el('option', { value: String(i), text: c.name })));
      const cur = comps.findIndex((c) => c.fc === m.fc);
      sel.value = String(cur < 0 ? 0 : cur);
    } else {
      field.hidden = true;
    }
  }

  function readMappingUI() {
    const v = (id) => parseInt($('#' + id).value, 10);
    const m = state.mapping;
    m.id = v('colId'); m.gene = v('colGene'); m.fc = v('colFc');
    m.p = v('colP'); m.padj = v('colPadj');
    m.desc = v('colDesc'); m.name = v('colName');
    m.fcScale = $('#colFcScale').value;
    m.pIsNegLog = $('#chkNegLog').checked;
  }

  function loadTable(table, sourceName) {
    state.table = table;
    state.sourceName = sourceName || '';
    state.mapping = VP.data.detectMapping(table.headers, table.rows);
    fillMappingUI();
    rebuildDataset();
    // A file with no usable p-value column is the one thing we cannot plot.
    if (state.mapping.fc < 0) {
      notice('dataNotice', 'No fold-change column was recognised. Pick one under <b>Column mapping</b>.', 'error');
    }
  }

  function rebuildDataset() {
    const t = state.table, m = state.mapping;
    if (!t || m.fc < 0) return;

    const ds = VP.data.buildDataset(t, m);
    state.dataset = ds;
    state.records = ds.records;
    state.pinned.clear();
    state.listMatched.clear();
    state.labelOffsets = {};
    state.view = null;
    state.lookup = buildLookup(ds.records);

    // Default to adjusted p only if the column is actually there.
    if (m.padj < 0) state.thresholds.useAdjusted = false;
    $('#selPType').value = state.thresholds.useAdjusted ? 'padj' : 'p';
    $('#selPType').querySelector('option[value="padj"]').disabled = m.padj < 0;

    const yl = state.thresholds.useAdjusted ? '−log₁₀ adjusted p-value' : '−log₁₀ p-value';
    state.config.yLabel = yl;
    $('#inpYLabel').value = yl;

    applyClusters();
    recompute();

    $('#emptyState').hidden = true;
    $('#rdTotal').textContent = ds.records.length.toLocaleString();

    const bits = [];
    if (ds.dropped.noFc) bits.push(ds.dropped.noFc + ' row(s) had no usable fold change');
    if (ds.dropped.noP) bits.push(ds.dropped.noP + ' row(s) had no p-value');
    if (ds.dropped.pOutOfRange) bits.push(ds.dropped.pOutOfRange + ' row(s) had a p-value outside 0–1');
    if (ds.capped) bits.push(ds.capped + ' p-value(s) were exactly 0 and were floored at ' + ds.pFloor.toExponential(1));
    notice('dataNotice',
      '<b>' + ds.records.length.toLocaleString() + '</b> proteins plotted from <b>' +
      U.escapeHtml(state.sourceName || 'table') + '</b>.' +
      (bits.length ? '<br>' + bits.join('; ') + '.' : ''),
      bits.length ? '' : 'ok');
    setStatus(ds.records.length.toLocaleString() + ' proteins · hover a point for details');
  }

  /* p-value / fold-change thresholds -> classes, counts, redraw. */
  function recompute() {
    if (!state.records.length) return;
    state.counts = VP.data.classify(state.records, {
      useAdjusted: state.thresholds.useAdjusted,
      pCutoff: state.thresholds.pCutoff,
      fcCutoff: state.thresholds.fcCutoff,
    });
    state.thresholds.fcCutoff = Math.abs(state.thresholds.fcCutoff);
    updateLabels();
    $('#rdUp').textContent = state.counts.up.toLocaleString();
    $('#rdDown').textContent = state.counts.down.toLocaleString();
    $('#tlUp').textContent = state.counts.up.toLocaleString();
    $('#tlDown').textContent = state.counts.down.toLocaleString();
    $('#tlNs').textContent = state.counts.ns.toLocaleString();

    const sig = state.counts.up + state.counts.down;
    if (state.records.length && sig === 0) {
      notice('thresholdNotice', 'No protein passes these cutoffs. Loosen the p-value or fold-change cutoff, or switch to the raw p-value.', 'soft');
    } else if (state.mapping && state.mapping.padj >= 0 && state.thresholds.useAdjusted && sig < 5 && state.records.length > 200) {
      notice('thresholdNotice', 'Only <b>' + sig + '</b> protein(s) pass with adjusted p-values. That is common when replicates are few — the raw p-value is the more permissive option, at the cost of multiple-testing control.', 'soft');
    } else {
      notice('thresholdNotice', '');
    }
    render();
  }

  function updateLabels() {
    const mode = state.labelTextMode;
    const auto = new Set();
    if (state.autoLabelN > 0) {
      const sig = state.records.filter((r) => r.cls !== 'ns');
      sig.sort((a, b) => (b.y * Math.abs(b.x)) - (a.y * Math.abs(a.x)));
      for (let i = 0; i < Math.min(state.autoLabelN, sig.length); i++) auto.add(sig[i].i);
    }
    let n = 0;
    for (const r of state.records) {
      r.highlighted = state.pinned.has(r.i) || state.listMatched.has(r.i);
      r.labelled = r.highlighted || auto.has(r.i);
      if (r.labelled) {
        n++;
        r.labelText = mode === 'id' ? (r.id || r.gene)
          : mode === 'name' ? (r.name || r.gene || r.id)
          : mode === 'both' ? ((r.gene || r.id) + (r.id && r.gene ? ' (' + r.id + ')' : ''))
          : (r.gene || r.id || r.name);
      }
    }
    $('#rdLabelled').textContent = String(n);
    renderPinList();
  }

  /* ======================= matching ======================= */

  const baseAcc = (a) => String(a || '').toUpperCase().replace(/-\d+$/, '');

  function buildLookup(records) {
    const map = new Map();
    const add = (key, i) => {
      if (!key) return;
      let arr = map.get(key);
      if (!arr) map.set(key, (arr = []));
      if (arr.indexOf(i) < 0) arr.push(i);
    };
    records.forEach((r) => {
      for (const id of r.ids) { add(id.toUpperCase(), r.i); add(baseAcc(id), r.i); }
      for (const g of r.genes) add(g.toUpperCase(), r.i);
      if (r.name) {
        add(r.name.toUpperCase(), r.i);
        add(r.name.toUpperCase().replace(/_[A-Z0-9]+$/, ''), r.i);
      }
    });
    return map;
  }

  function parseTerms(text) {
    return String(text || '')
      .split(/[\s,;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function matchTerms(terms) {
    const matched = new Set();
    const missed = [];
    for (const t of terms) {
      const key = t.toUpperCase();
      const hit = state.lookup.get(key) || state.lookup.get(baseAcc(key));
      if (hit) hit.forEach((i) => matched.add(i));
      else missed.push(t);
    }
    return { matched, missed };
  }

  /* ======================= clusters ======================= */

  let clusterSeq = 0;

  function addCluster(spec) {
    const style = CLUSTER_STYLES[state.clusters.length % CLUSTER_STYLES.length];
    const cluster = {
      id: 'c' + (++clusterSeq),
      name: spec.name,
      genes: spec.genes || new Set(),
      accessions: spec.accessions || new Set(),
      color: spec.color || style.color,
      shape: spec.shape || style.shape,
      visible: true,
      source: spec.source || '',
      total: spec.total != null ? spec.total : (spec.genes ? spec.genes.size : 0),
      matched: 0,
    };
    state.clusters.push(cluster);
    applyClusters();
    recompute();
    renderClusterList();
    if (!cluster.matched) {
      toast('"' + cluster.name + '" has ' + cluster.total + ' member(s) but none of them are in your dataset. Check the organism.', 'error', 'No overlap');
    } else {
      toast(cluster.matched + ' of ' + cluster.total + ' members found in your data.', 'ok', cluster.name);
    }
    return cluster;
  }

  function applyClusters() {
    for (const r of state.records) r.clusters = null;
    for (const c of state.clusters) {
      c.matched = 0;
      if (!c.visible) continue;
      for (const r of state.records) {
        let hit = false;
        for (const g of r.genes) { if (c.genes.has(g.toUpperCase())) { hit = true; break; } }
        if (!hit && c.accessions.size) {
          for (const id of r.ids) {
            if (c.accessions.has(id.toUpperCase()) || c.accessions.has(baseAcc(id))) { hit = true; break; }
          }
        }
        if (!hit && r.name && c.genes.has(r.name.toUpperCase().replace(/_[A-Z0-9]+$/, ''))) hit = true;
        if (hit) {
          (r.clusters || (r.clusters = [])).push(c);
          c.matched++;
        }
      }
    }
  }

  function renderClusterList() {
    const box = clear($('#clusterList'));
    if (!state.clusters.length) {
      box.appendChild(el('p', { class: 'empty', text: 'No clusters yet.' }));
      return;
    }
    state.clusters.forEach((c) => {
      const colorInput = el('input', { type: 'color', value: c.color, title: 'Cluster colour' });
      colorInput.addEventListener('input', () => { c.color = colorInput.value; render(); });

      const shapeSel = el('select', { title: 'Marker shape' });
      VP.surface.SHAPES.forEach((s) => shapeSel.appendChild(el('option', { value: s, text: s })));
      shapeSel.value = c.shape;
      shapeSel.addEventListener('change', () => { c.shape = shapeSel.value; render(); });

      const vis = el('input', { type: 'checkbox', checked: c.visible, title: 'Show on plot' });
      vis.addEventListener('change', () => {
        c.visible = vis.checked;
        applyClusters(); recompute(); renderClusterList();
      });

      const del = el('button', { class: 'icon-btn', text: '×', title: 'Remove cluster' });
      del.addEventListener('click', () => {
        state.clusters = state.clusters.filter((x) => x !== c);
        applyClusters(); recompute(); renderClusterList();
      });

      box.appendChild(el('div', { class: 'cluster' }, [
        vis, colorInput,
        el('div', { class: 'cluster-body' }, [
          el('div', { class: 'cluster-name', title: c.name, text: c.name }),
          el('div', { class: 'cluster-meta', text: c.matched + ' / ' + c.total + ' in data' + (c.source ? ' · ' + c.source : '') }),
        ]),
        shapeSel, del,
      ]));
    });
  }

  /* ======================= hover card ======================= */

  const tip = $('#tooltip');
  let hoverRec = null;

  function libGeneIndex(lib) {
    if (lib._geneIndex) return lib._geneIndex;
    const idx = new Map();
    for (const t of lib.terms) {
      for (const g of t.genes) {
        let arr = idx.get(g);
        if (!arr) idx.set(g, (arr = []));
        if (arr.length < 12) arr.push(t.term);
      }
    }
    lib._geneIndex = idx;
    return idx;
  }

  /* Terms from any loaded library that contain this protein - instant, offline,
     and a useful stand-in when UniProt is slow or unreachable. */
  function localTerms(rec, kinds) {
    const out = [];
    for (const name of VP.api.loadedLibraryNames()) {
      const isLoc = /cellular_component|compartment|corum/i.test(name);
      if (kinds === 'location' && !isLoc) continue;
      if (kinds === 'pathway' && isLoc) continue;
      const idx = libGeneIndex(VP.api.getLibrary(name));
      for (const g of rec.genes) {
        const hits = idx.get(g.toUpperCase());
        if (hits) for (const h of hits) if (out.indexOf(h) < 0) out.push(h);
      }
      if (out.length >= 4) break;
    }
    return out.slice(0, 4);
  }

  function tooltipStats(rec) {
    const parts = [];
    parts.push('<span>log₂FC <b>' + fmtNum(rec.x, 2) + '</b></span>');
    if (rec.fcRaw != null && state.mapping.fcScale !== 'log2') {
      parts.push('<span><i>raw</i> <b>' + fmtNum(rec.fcRaw, 2) + '</b></span>');
    }
    if (rec.p != null) parts.push('<span>p <b>' + fmtP(rec.p) + '</b></span>');
    if (rec.padj != null) parts.push('<span>p<i>adj</i> <b>' + fmtP(rec.padj) + '</b></span>');
    return parts.join('');
  }

  function showTooltip(rec, clientX, clientY) {
    $('#ttGene').textContent = rec.gene || rec.id || rec.name || '—';
    const badge = $('#ttBadge');
    badge.className = 'tt-badge ' + rec.cls;
    badge.textContent = rec.cls === 'up' ? 'up' : rec.cls === 'down' ? 'down' : 'n.s.';

    const ids = [];
    if (rec.ids.length) ids.push(rec.ids.join(' · '));
    if (rec.name) ids.push(rec.name);
    $('#ttIds').textContent = ids.join('  |  ');
    $('#ttStats').innerHTML = tooltipStats(rec);
    $('#ttDesc').textContent = rec.desc || '';
    $('#ttDesc').hidden = !rec.desc;

    // Cluster membership is known locally, so it paints immediately.
    const cl = clear($('#ttClusters'));
    if (rec.clusters) {
      for (const c of rec.clusters) {
        cl.appendChild(el('span', { class: 'tt-chip' }, [
          el('span', { class: 'dot', style: 'background:' + c.color }),
          el('span', { text: c.name }),
        ]));
      }
    }

    // Look up by accession when the file has one, otherwise by gene symbol -
    // plenty of result tables only carry gene names.
    const acc = rec.ids.length ? baseAcc(rec.ids[0]) : '';
    const taxon = (VP.api.ORGANISMS.find((o) => o.id === state.organism) || {}).taxon;
    const key = acc ? 'ann.' + acc : (rec.gene ? 'anng.' + rec.gene.toUpperCase() + '.' + (taxon || 0) : null);
    const cached = key ? VP.api.cacheGet(key, true) : undefined;
    const pending = !!key && cached === undefined && !annotationFailed;
    paintAnnotation(rec, cached, pending);

    $('#ttFoot').textContent = state.pinned.has(rec.i)
      ? 'click to unpin label' : 'click to pin label';

    tip.hidden = false;
    positionTooltip(clientX, clientY);

    if (pending) queueAnnotation(rec, acc, taxon);
  }

  /* A row is shown only when it has something to say, or a lookup is genuinely
     in flight - never a permanent "looking up..." for data that is not coming. */
  function setAnnRow(rowId, ddId, text, pending) {
    const dd = $('#' + ddId);
    const row = $('#' + rowId);
    if (text) {
      dd.classList.remove('loading');
      dd.textContent = text;
      row.hidden = false;
    } else if (pending) {
      dd.classList.add('loading');
      dd.textContent = 'looking up\u2026';
      row.hidden = false;
    } else {
      row.hidden = true;
    }
  }

  function paintAnnotation(rec, ann, pending) {
    const good = ann && !ann.missing;
    // Anything a loaded gene-set library already knows is free and instant, and
    // stands in when UniProt is slow or blocked.
    const locLocal = localTerms(rec, 'location').join('; ');
    const pathLocal = localTerms(rec, 'pathway').join('; ');

    const loc = (good && ann.locations && ann.locations.length ? ann.locations.join('; ') : '') || locLocal;
    const path = (good && ann.pathway ? ann.pathway : '') || pathLocal;
    const func = (good && ann.function ? ann.function : '') ||
      (good && ann.proteinName ? ann.proteinName : '') || rec.desc || '';

    setAnnRow('ttLocRow', 'ttLoc', loc, pending && !loc);
    setAnnRow('ttPathRow', 'ttPath', path, pending && !path);
    setAnnRow('ttFuncRow', 'ttFunc', func, pending && !func);
  }

  // Hovering sweeps across hundreds of points; only ask UniProt about the one
  // the cursor actually settles on.
  let annotationFailed = false;
  const queueAnnotation = debounce((rec, acc, taxon) => {
    if (annotationFailed) return;
    if (!hoverRec || hoverRec.i !== rec.i) return;
    const job = acc
      ? VP.api.fetchAnnotations([acc]).then((map) => map.get(acc))
      : VP.api.fetchAnnotationByGene(rec.gene, taxon);
    job.then((ann) => {
      if (hoverRec && hoverRec.i === rec.i) paintAnnotation(rec, ann, false);
    }).catch((err) => {
      annotationFailed = true;
      if (hoverRec && hoverRec.i === rec.i) paintAnnotation(rec, { missing: true }, false);
      toast(err.message + ' Hover cards fall back to your file\u2019s own description and any loaded gene-set library.',
        'error', 'UniProt unavailable');
    });
  }, 330);

  function positionTooltip(cx, cy) {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = cx + pad, y = cy + pad;
    if (x + r.width > window.innerWidth - 8) x = cx - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = cy - r.height - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  const hideTooltip = () => { tip.hidden = true; hoverRec = null; };

  /* ======================= canvas interaction ======================= */

  const canvas = $('#plot');
  let drag = null;

  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * (state.config.width / r.width),
      y: (ev.clientY - r.top) * (state.config.height / r.height),
    };
  }

  function currentDomain() {
    return state.view || (state.records.length ? VP.plot.autoDomain(state) : null);
  }

  function labelAt(px, py) {
    if (!state.geom) return null;
    const laid = VP.plot.layoutLabels(state, state.geom);
    for (const L of laid.labels) {
      const w = VP.surface.measureText(L.text, laid.font);
      const x0 = L.anchor === 'start' ? L.x : L.anchor === 'end' ? L.x - w : L.x - w / 2;
      if (px >= x0 - 3 && px <= x0 + w + 3 && py >= L.y - laid.font.size && py <= L.y + 4) return L;
    }
    return null;
  }

  canvas.addEventListener('mousemove', (ev) => {
    if (!state.records.length) return;
    const p = canvasPos(ev);

    if (drag) {
      if (drag.kind === 'pan') {
        const d = currentDomain();
        const kx = (d.x1 - d.x0) / state.geom.plotW;
        const ky = (d.y1 - d.y0) / state.geom.plotH;
        const dx = (p.x - drag.lastX) * kx;
        const dy = (p.y - drag.lastY) * ky;
        state.view = { x0: d.x0 - dx, x1: d.x1 - dx, y0: d.y0 + dy, y1: d.y1 + dy };
        drag.lastX = p.x; drag.lastY = p.y;
        drag.moved = true;
        render();
      } else if (drag.kind === 'box') {
        drag.curX = p.x; drag.curY = p.y;
        drawSelectionBox(drag);
        drag.moved = true;
      } else if (drag.kind === 'label') {
        state.labelOffsets[drag.rec.i] = {
          dx: drag.baseDx + (p.x - drag.startX),
          dy: drag.baseDy + (p.y - drag.startY),
        };
        drag.moved = true;
        render();
      }
      return;
    }

    const hit = VP.plot.hitTest(state.index, p.x, p.y);
    const onLabel = !hit && labelAt(p.x, p.y);
    canvas.classList.toggle('on-point', !!hit);
    canvas.classList.toggle('on-label', !!onLabel);

    if (hit) {
      if (!hoverRec || hoverRec.i !== hit.rec.i) {
        hoverRec = hit.rec;
        showTooltip(hit.rec, ev.clientX, ev.clientY);
      } else {
        positionTooltip(ev.clientX, ev.clientY);
      }
    } else if (hoverRec) {
      hideTooltip();
    }
  });

  canvas.addEventListener('mouseleave', () => { if (!drag) hideTooltip(); });

  canvas.addEventListener('mousedown', (ev) => {
    if (!state.records.length || ev.button !== 0) return;
    const p = canvasPos(ev);
    const L = labelAt(p.x, p.y);
    if (L) {
      const off = state.labelOffsets[L.rec.i];
      drag = {
        kind: 'label', rec: L.rec, startX: p.x, startY: p.y,
        baseDx: off ? off.dx : L.x - L.px,
        baseDy: off ? off.dy : L.y - L.py,
        moved: false,
      };
      hideTooltip();
      ev.preventDefault();
      return;
    }
    if (ev.shiftKey || state.mode === 'select') {
      drag = { kind: 'box', startX: p.x, startY: p.y, curX: p.x, curY: p.y, moved: false };
    } else {
      drag = { kind: 'pan', lastX: p.x, lastY: p.y, downX: p.x, downY: p.y, moved: false };
      canvas.classList.add('is-panning');
    }
    ev.preventDefault();
  });

  window.addEventListener('mouseup', (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('is-panning');

    if (d.kind === 'box') {
      $('#selectionBox').hidden = true;
      if (d.moved && Math.abs(d.curX - d.startX) > 4 && Math.abs(d.curY - d.startY) > 4) {
        const inside = VP.plot.pointsInRect(state.index, d.startX, d.startY, d.curX, d.curY);
        inside.forEach((r) => state.pinned.add(r.i));
        toast(inside.length + ' protein(s) labelled.', 'ok', 'Box label');
        recompute();
      }
      return;
    }
    if (d.kind === 'label') {
      if (!d.moved) { togglePin(d.rec); }
      return;
    }
    if (d.kind === 'pan' && !d.moved) {
      const hit = VP.plot.hitTest(state.index, d.downX, d.downY);
      if (hit) togglePin(hit.rec);
    }
  });

  function togglePin(rec) {
    if (state.pinned.has(rec.i)) state.pinned.delete(rec.i);
    else state.pinned.add(rec.i);
    recompute();
    if (hoverRec && hoverRec.i === rec.i) {
      $('#ttFoot').textContent = state.pinned.has(rec.i) ? 'click to unpin label' : 'click to pin label';
    }
  }

  function drawSelectionBox(d) {
    const box = $('#selectionBox');
    const r = canvas.getBoundingClientRect();
    const kx = r.width / state.config.width, ky = r.height / state.config.height;
    box.hidden = false;
    box.style.left = Math.min(d.startX, d.curX) * kx + 'px';
    box.style.top = Math.min(d.startY, d.curY) * ky + 'px';
    box.style.width = Math.abs(d.curX - d.startX) * kx + 'px';
    box.style.height = Math.abs(d.curY - d.startY) * ky + 'px';
  }

  canvas.addEventListener('wheel', (ev) => {
    if (!state.records.length || !state.geom) return;
    ev.preventDefault();
    const p = canvasPos(ev);
    zoomAt(p.x, p.y, ev.deltaY > 0 ? 1.16 : 1 / 1.16);
  }, { passive: false });

  function zoomAt(px, py, factor) {
    const d = currentDomain();
    const g = state.geom;
    if (!d || !g) return;
    const cx = g.ix(px), cy = g.iy(py);
    let x0 = cx + (d.x0 - cx) * factor, x1 = cx + (d.x1 - cx) * factor;
    let y0 = cy + (d.y0 - cy) * factor, y1 = cy + (d.y1 - cy) * factor;
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-6) return;
    state.view = { x0, x1, y0, y1 };
    render();
  }

  canvas.addEventListener('dblclick', (ev) => {
    const p = canvasPos(ev);
    const L = labelAt(p.x, p.y);
    if (L) { delete state.labelOffsets[L.rec.i]; render(); return; }
    resetView();
  });

  function resetView() { state.view = null; render(); }

  /* ======================= pin list ======================= */

  function renderPinList() {
    const box = clear($('#pinList'));
    const items = state.records.filter((r) => state.pinned.has(r.i) || state.listMatched.has(r.i));
    if (!items.length) {
      box.appendChild(el('p', { class: 'empty', text: 'Nothing pinned yet.' }));
      return;
    }
    items.slice(0, 200).forEach((r) => {
      const rm = el('button', { class: 'icon-btn', text: '×', title: 'Remove label' });
      rm.addEventListener('click', () => {
        state.pinned.delete(r.i);
        state.listMatched.delete(r.i);
        recompute();
      });
      box.appendChild(el('div', { class: 'pin' }, [
        el('span', { class: 'pin-name', text: r.gene || r.id }),
        el('span', { class: 'pin-stat', text: fmtNum(r.x, 2) + ' · ' + fmtP(r.pUsed) }),
        rm,
      ]));
    });
  }

  /* ======================= enrichment ======================= */

  function currentGeneSet() {
    const which = $('#selEnrichSet').value;
    let recs;
    if (which === 'up') recs = state.records.filter((r) => r.cls === 'up');
    else if (which === 'down') recs = state.records.filter((r) => r.cls === 'down');
    else if (which === 'both') recs = state.records.filter((r) => r.cls !== 'ns');
    else if (which === 'labelled') recs = state.records.filter((r) => r.labelled);
    else {
      const c = state.clusters[0];
      recs = c ? state.records.filter((r) => r.clusters && r.clusters.indexOf(c) >= 0) : [];
    }
    const genes = [];
    const seen = new Set();
    for (const r of recs) {
      const g = (r.gene || r.id || '').toUpperCase();
      if (g && !seen.has(g)) { seen.add(g); genes.push(g); }
    }
    return genes;
  }

  function datasetBackground() {
    const seen = new Set();
    for (const r of state.records) {
      const g = (r.gene || r.id || '').toUpperCase();
      if (g) seen.add(g);
    }
    return Array.from(seen);
  }

  function updateEnrichHint() {
    const n = currentGeneSet().length;
    $('#enrichSetHint').textContent = n
      ? n.toLocaleString() + ' unique gene name(s) will be tested.'
      : 'No proteins in this set yet.';
  }

  async function runEnrichment() {
    const genes = currentGeneSet();
    if (!genes.length) { toast('That set is empty — adjust your cutoffs or label some proteins first.', 'error'); return; }

    const provider = $('#selProvider').value;
    const pCut = parseFloat($('#inpEnrichP').value) || 0.05;
    const useDatasetBg = $('#selBackground').value === 'dataset';
    const btn = $('#btnRunEnrich');
    btn.disabled = true;
    btn.textContent = 'Running…';
    notice('enrichNotice', '');

    try {
      let res;
      if (provider === 'gprofiler') {
        const sources = Array.from(document.querySelectorAll('#gpSources .chip.on')).map((c) => c.dataset.src);
        res = await VP.api.gprofiler(genes, {
          organism: state.organism,
          sources,
          pCutoff: pCut,
          background: useDatasetBg ? datasetBackground() : null,
        });
      } else if (provider === 'enrichr') {
        const lib = $('#selEnrichLib').value;
        if (!lib) throw new Error('Choose a library first.');
        res = await VP.api.enrichr(genes, lib);
        res.results = res.results.filter((r) => r.p_adjusted <= Math.max(pCut, 0.25));
      } else {
        const lib = $('#selEnrichLib').value;
        if (!lib) throw new Error('Choose a library first.');
        const loaded = VP.api.getLibrary(lib) || await VP.api.loadLibrary(lib, (p) => {
          setStatus(p.phase === 'download' ? 'Downloading ' + p.name + '…' : 'Parsing ' + p.name + '…');
        });
        const out = VP.stats.overRepresentation(genes, loaded.terms, {
          background: useDatasetBg ? datasetBackground() : null,
        });
        res = { provider: 'Built-in (hypergeometric)', results: out.results.filter((r) => r.p_adjusted <= Math.max(pCut, 0.25)) };
        $('#enrichSummary').hidden = false;
        $('#enrichSummary').innerHTML = '<b>' + out.queryMapped + '</b> of ' + out.queryTotal +
          ' query genes were found in the background of <b>' + out.background.toLocaleString() + '</b> genes.';
      }

      state.enrich.results = res.results || [];
      state.enrich.provider = res.provider;
      state.enrich.annotated = new Set();
      renderEnrichTable();
      openDrawer(true);

      if (!state.enrich.results.length) {
        notice('enrichNotice', 'No terms passed the cutoff. Try a looser significance cutoff, a broader source, or a larger gene set.', 'soft');
      } else {
        notice('enrichNotice', '<b>' + state.enrich.results.length + '</b> enriched term(s) via ' +
          U.escapeHtml(res.provider) + '.', 'ok');
      }
      setStatus(state.enrich.results.length + ' enriched terms · ' + res.provider);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      notice('enrichNotice', U.escapeHtml(msg) +
        '<br><br>The <b>Built-in</b> engine runs entirely in your browser once a gene-set library has been downloaded — try that if the server is unreachable.', 'error');
      toast(msg, 'error', 'Enrichment failed');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run enrichment';
    }
  }

  function renderEnrichTable() {
    const body = clear($('#enrichBody'));
    const { sortKey, sortDir, filter } = state.enrich;
    let rows = state.enrich.results.slice();
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter((r) => (r.name || '').toLowerCase().indexOf(f) >= 0 ||
        (r.source || '').toLowerCase().indexOf(f) >= 0);
    }
    rows.sort(U.by((r) => r[sortKey], sortDir));

    document.querySelectorAll('#enrichTable th.sortable').forEach((th) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === sortKey) th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    });

    rows.slice(0, 500).forEach((r) => {
      const on = state.enrich.annotated.has(r.id);
      const btn = el('button', { class: 'mini' + (on ? ' on' : ''), text: on ? 'on plot' : 'annotate' });
      btn.addEventListener('click', () => annotateTerm(r, btn));

      const tr = el('tr', { class: on ? 'is-annotated' : '' }, [
        el('td', { class: 'term-cell' }, [
          el('span', { text: r.name || r.id }),
          r.genes && r.genes.length
            ? el('span', { class: 'genes', text: r.genes.slice(0, 24).join(' ') + (r.genes.length > 24 ? ' …+' + (r.genes.length - 24) : '') })
            : null,
        ]),
        el('td', {}, el('span', { class: 'src', text: r.source || '' })),
        el('td', { class: 'num', text: fmtP(r.p_adjusted != null ? r.p_adjusted : r.p_value) }),
        el('td', { class: 'num', text: String(r.intersection_size == null ? '—' : r.intersection_size) }),
        el('td', { class: 'num', text: String(r.term_size == null ? '—' : r.term_size) }),
        el('td', { class: 'num', text: r.fold_enrichment ? fmtNum(r.fold_enrichment, 1) : '—' }),
        el('td', {}, btn),
      ]);
      body.appendChild(tr);
    });

    $('#drawerMeta').textContent = state.enrich.results.length
      ? state.enrich.results.length + ' terms · ' + state.enrich.provider : '';
    $('#enrichProvider').textContent = state.enrich.provider ? 'via ' + state.enrich.provider : '';
    if (!rows.length) {
      body.appendChild(el('tr', {}, el('td', { colspan: '7' },
        el('p', { class: 'empty', text: 'No results. Run an analysis from the Pathways panel.' }))));
    }
  }

  /* Turn one enrichment result into a plot overlay. */
  function annotateTerm(r, btn) {
    if (state.enrich.annotated.has(r.id)) {
      state.clusters = state.clusters.filter((c) => c.termId !== r.id);
      state.enrich.annotated.delete(r.id);
    } else {
      let genes = r.genes && r.genes.length ? r.genes.map((g) => String(g).toUpperCase()) : null;
      if (!genes) {
        toast('This engine did not return the member genes for that term.', 'error');
        return;
      }
      const c = addCluster({
        name: r.name || r.id,
        genes: new Set(genes),
        total: genes.length,
        source: r.source || state.enrich.provider,
      });
      c.termId = r.id;
      state.enrich.annotated.add(r.id);
    }
    applyClusters();
    recompute();
    renderClusterList();
    renderEnrichTable();
  }

  function openDrawer(open) {
    $('#drawer').dataset.state = open ? 'open' : 'closed';
  }

  /* ======================= GO term search ======================= */

  async function searchTerms() {
    const q = $('#inpTermSearch').value.trim();
    if (!q) return;
    const box = clear($('#termResults'));
    box.appendChild(el('p', { class: 'empty', text: 'Searching…' }));
    notice('clusterNotice', '');

    try {
      const source = $('#selSource').value;
      let items = [];
      if (source === 'library') {
        const libName = $('#selLibrary').value;
        if (!VP.api.libraryLoaded(libName)) await loadLibraryUI(libName);
        items = VP.api.searchLibrary(libName, q, 60).map((t) => ({
          key: t.term,
          title: t.term,
          meta: t.genes.size + ' genes · ' + libName,
          genes: t.genes,
          source: libName,
        }));
      } else {
        const terms = await VP.api.searchGoTerms(q, { limit: 25 });
        items = terms.map((t) => ({
          key: t.id,
          title: t.name + ' (' + t.id + ')',
          meta: (t.aspect || 'GO') + ' · fetched from UniProt on demand',
          goId: t.id,
          source: t.source,
        }));
      }

      clear(box);
      if (!items.length) {
        box.appendChild(el('p', { class: 'empty', text: 'No matching terms.' }));
        return;
      }
      items.forEach((it) => {
        const add = el('button', { class: 'term-add', text: '+', title: 'Overlay on plot' });
        const row = el('div', { class: 'term' }, [
          el('div', { class: 'term-body' }, [
            el('div', { class: 'term-name', text: it.title }),
            el('div', { class: 'term-meta', text: it.meta }),
          ]),
          add,
        ]);
        const go = async () => {
          add.disabled = true;
          try {
            if (it.genes) {
              addCluster({ name: it.title, genes: it.genes, total: it.genes.size, source: it.source });
            } else {
              add.textContent = '…';
              const taxon = (VP.api.ORGANISMS.find((o) => o.id === state.organism) || {}).taxon;
              const members = await VP.api.fetchGoMembers(it.goId, taxon, { reviewed: true });
              addCluster({
                name: it.title, genes: members.genes, accessions: members.accessions,
                total: members.n, source: 'UniProt',
              });
            }
          } catch (err) {
            notice('clusterNotice', U.escapeHtml(err.message), 'error');
            toast(err.message, 'error', 'Lookup failed');
          } finally {
            add.disabled = false;
            add.textContent = '+';
          }
        };
        add.addEventListener('click', (e) => { e.stopPropagation(); go(); });
        row.addEventListener('click', go);
        box.appendChild(row);
      });
    } catch (err) {
      clear(box).appendChild(el('p', { class: 'empty', text: 'Search failed.' }));
      notice('clusterNotice', U.escapeHtml(err.message), 'error');
    }
  }

  async function loadLibraryUI(name) {
    const status = $('#libStatus');
    status.textContent = 'downloading…';
    try {
      const lib = await VP.api.loadLibrary(name, (p) => {
        status.textContent = p.phase === 'download' ? 'downloading…' : 'parsing…';
      });
      status.textContent = lib.terms.length.toLocaleString() + ' terms loaded';
      return lib;
    } catch (err) {
      status.textContent = 'failed';
      notice('clusterNotice', U.escapeHtml(err.message), 'error');
      throw err;
    }
  }

  /* ======================= export ======================= */

  function figureName(ext) {
    const base = (state.sourceName || 'volcano').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
    return base + '_volcano.' + ext;
  }

  function exportPng(scale) {
    if (!state.records.length) { toast('Load some data first.', 'error'); return; }
    const cfg = state.config;
    const c = document.createElement('canvas');
    c.width = Math.round(cfg.width * scale);
    c.height = Math.round(cfg.height * scale);
    const ctx = c.getContext('2d');
    VP.plot.draw(VP.surface.canvas(ctx, scale), state);
    c.toBlob((blob) => {
      U.downloadBlob(blob, figureName('png'));
      toast(c.width + ' × ' + c.height + ' px', 'ok', 'PNG exported');
    }, 'image/png');
  }

  function exportSvg() {
    if (!state.records.length) { toast('Load some data first.', 'error'); return; }
    const cfg = state.config;
    const s = VP.surface.svg(cfg.width, cfg.height);
    VP.plot.draw(s, state);
    U.downloadText(s.toString(), figureName('svg'), 'image/svg+xml');
    toast('Layers: points, labels, axes, legend.', 'ok', 'SVG exported');
  }

  function exportCsv(onlySig) {
    if (!state.records.length) { toast('Load some data first.', 'error'); return; }
    const rows = [['protein_id', 'gene', 'entry_name', 'description', 'fold_change_raw',
      'log2_fold_change', 'p_value', 'adjusted_p_value', 'neg_log10_p_used',
      'classification', 'labelled', 'clusters']];
    for (const r of state.records) {
      if (onlySig && r.cls === 'ns') continue;
      rows.push([
        r.ids.join(';'), r.genes.join(';'), r.name, r.desc,
        r.fcRaw, r.x, r.p, r.padj, r.y, r.cls,
        r.labelled ? 'yes' : '', r.clusters ? r.clusters.map((c) => c.name).join(';') : '',
      ]);
    }
    U.downloadText(U.toCsv(rows), figureName('').replace(/\.$/, '') + (onlySig ? '_significant.csv' : '_all.csv'), 'text/csv');
  }

  function exportEnrichCsv() {
    if (!state.enrich.results.length) { toast('Run an enrichment first.', 'error'); return; }
    const rows = [['term_id', 'term_name', 'source', 'p_value', 'adjusted_p_value',
      'intersection_size', 'term_size', 'query_size', 'background_size', 'fold_enrichment', 'genes']];
    for (const r of state.enrich.results) {
      rows.push([r.id, r.name, r.source, r.p_value, r.p_adjusted, r.intersection_size,
        r.term_size, r.query_size, r.background_size, r.fold_enrichment,
        (r.genes || []).join(';')]);
    }
    U.downloadText(U.toCsv(rows), 'enrichment_' + (state.enrich.provider || '').replace(/\W+/g, '_') + '.csv', 'text/csv');
  }

  function saveSession() {
    const data = {
      version: 1,
      config: state.config,
      thresholds: state.thresholds,
      organism: state.organism,
      labelTextMode: state.labelTextMode,
      autoLabelN: state.autoLabelN,
      proteinList: $('#proteinList').value,
      clusters: state.clusters.map((c) => ({
        name: c.name, color: c.color, shape: c.shape, visible: c.visible,
        source: c.source, genes: Array.from(c.genes), accessions: Array.from(c.accessions),
      })),
    };
    U.downloadText(JSON.stringify(data, null, 2), 'volcano_studio_settings.json', 'application/json');
  }

  function restoreSession(json) {
    try {
      const d = JSON.parse(json);
      if (d.config) Object.assign(state.config, d.config);
      if (d.thresholds) Object.assign(state.thresholds, d.thresholds);
      if (d.organism) state.organism = d.organism;
      state.labelTextMode = d.labelTextMode || 'gene';
      state.autoLabelN = d.autoLabelN || 0;
      if (d.proteinList != null) $('#proteinList').value = d.proteinList;
      if (Array.isArray(d.clusters)) {
        state.clusters = d.clusters.map((c, i) => ({
          id: 'c' + (++clusterSeq), name: c.name, color: c.color, shape: c.shape,
          visible: c.visible !== false, source: c.source || 'restored',
          genes: new Set(c.genes || []), accessions: new Set(c.accessions || []),
          total: (c.genes || []).length, matched: 0,
        }));
      }
      syncControlsFromState();
      applyList(false);
      applyClusters();
      recompute();
      renderClusterList();
      toast('Settings restored.', 'ok');
    } catch (e) {
      toast('That file could not be read as a settings file.', 'error');
    }
  }

  /* ======================= control wiring ======================= */

  function syncControlsFromState() {
    const cfg = state.config, th = state.thresholds;

    $('#inpP').value = th.pCutoff;
    $('#outP').textContent = String(th.pCutoff);
    $('#rngP').value = String(pToSlider(th.pCutoff));
    $('#inpFc').value = th.fcCutoff;
    $('#outFc').textContent = th.fcCutoff.toFixed(2);
    $('#rngFc').value = String(Math.round(th.fcCutoff * 100));
    $('#selPType').value = th.useAdjusted ? 'padj' : 'p';

    $('#selFont').value = cfg.font.family;
    $('#inpTickSize').value = cfg.font.tickSize;
    $('#inpAxisSize').value = cfg.font.axisTitleSize;
    $('#inpLabelSize').value = cfg.font.labelSize;
    $('#inpTitleSize').value = cfg.font.titleSize;
    $('#chkLabelBold').checked = cfg.font.labelWeight === 'bold';
    $('#chkLabelItalic').checked = !!cfg.font.labelItalic;

    $('#rngSize').value = String(Math.round(cfg.point.size * 10));
    $('#outSize').textContent = cfg.point.size.toFixed(1);
    $('#rngOpacity').value = String(Math.round(cfg.point.opacity * 100));
    $('#outOpacity').textContent = cfg.point.opacity.toFixed(2);
    $('#rngStroke').value = String(Math.round(cfg.point.strokeWidth * 10));
    $('#outStroke').textContent = cfg.point.strokeWidth.toFixed(1);

    $('#colUp').value = cfg.colors.up;
    $('#colDown').value = cfg.colors.down;
    $('#colNs').value = cfg.colors.ns;
    $('#colHighlight').value = cfg.colors.highlight;
    $('#colBg').value = cfg.colors.background;
    $('#colGrid').value = cfg.colors.grid;

    $('#inpTitle').value = cfg.title;
    $('#inpXLabel').value = cfg.xLabel;
    $('#inpYLabel').value = cfg.yLabel;
    $('#inpWidth').value = cfg.width;
    $('#inpHeight').value = cfg.height;
    $('#selAxisStyle').value = cfg.axisStyle;
    $('#selLegendPos').value = cfg.legend.show ? cfg.legend.position : 'none';
    $('#chkGrid').checked = cfg.showGrid;
    $('#chkThresholds').checked = cfg.showThresholds;
    $('#chkSymmetric').checked = cfg.symmetricX;
    $('#chkLegendCounts').checked = cfg.legend.showCounts;
    $('#chkHalo').checked = cfg.label.halo;
    $('#chkLeader').checked = cfg.label.leader;
    $('#rngAutoLabel').value = String(state.autoLabelN);
    $('#outAutoLabel').textContent = String(state.autoLabelN);
    $('#selLabelText').value = state.labelTextMode;
    $('#selOrganism').value = state.organism;
    updatePngHint();
  }

  // p-value slider is logarithmic: 1 down to 1e-6.
  const sliderToP = (v) => Math.pow(10, -(v / 100) * 6);
  const pToSlider = (p) => clamp(-Math.log10(Math.max(p, 1e-6)) / 6 * 100, 0, 100);

  function updatePngHint() {
    const s = parseInt($('#selPngScale').value, 10);
    $('#pngHint').textContent = Math.round(state.config.width * s) + ' × ' +
      Math.round(state.config.height * s) + ' px';
  }

  function applyList(announce) {
    const terms = parseTerms($('#proteinList').value);
    state.listMatched.clear();
    if (!terms.length) {
      $('#matchReport').hidden = true;
      recompute();
      return;
    }
    const { matched, missed } = matchTerms(terms);
    matched.forEach((i) => state.listMatched.add(i));
    const rep = $('#matchReport');
    rep.hidden = false;
    rep.innerHTML = '<b>' + matched.size + '</b> of ' + terms.length + ' entries matched and labelled.' +
      (missed.length
        ? '<div class="missed">Not found: ' + missed.slice(0, 60).map((m) => '<em>' + U.escapeHtml(m) + '</em>').join(', ') +
          (missed.length > 60 ? ' …and ' + (missed.length - 60) + ' more' : '') + '</div>'
        : '');
    recompute();
    if (announce !== false) {
      toast(matched.size + ' matched, ' + missed.length + ' not found.', missed.length ? '' : 'ok', 'Protein list');
    }
  }

  function bind() {
    /* --- rail --- */
    document.querySelectorAll('.rail-btn').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('is-active', x === b));
        document.querySelectorAll('.panel').forEach((p) => {
          p.classList.toggle('is-active', p.dataset.panel === b.dataset.panel);
        });
        if (b.dataset.panel === 'pathways') updateEnrichHint();
      });
    });

    /* --- file loading --- */
    const dz = $('#dropzone');
    $('#btnBrowse').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    // Dropping anywhere on the window works too.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    $('#btnPaste').addEventListener('click', () => {
      const txt = $('#pasteArea').value.trim();
      if (!txt) { toast('Nothing pasted.', 'error'); return; }
      const parsed = VP.data.parseDelimited(txt);
      loadTable(VP.data.toTable(parsed.rows), 'pasted table');
    });

    const loadDemo = () => {
      const t = VP.demo.table();
      loadTable({ headers: t.headers, rows: t.rows }, 'example dataset');
      toast('Simulated organelle-enrichment experiment with real human gene symbols.', 'ok', 'Example loaded');
    };
    $('#btnDemo').addEventListener('click', loadDemo);
    $('#btnDemo2').addEventListener('click', loadDemo);

    $('#selSheet').addEventListener('change', () => {
      const i = parseInt($('#selSheet').value, 10);
      const sheet = state.workbook.sheets[i];
      loadTable(VP.data.toTable(sheet.rows), state.sourceName.replace(/ \[.*\]$/, '') + ' [' + sheet.name + ']');
    });

    $('#btnApplyMapping').addEventListener('click', () => {
      readMappingUI();
      if (state.mapping.fc < 0) { toast('Choose a fold-change column.', 'error'); return; }
      rebuildDataset();
    });
    $('#colFcScale').addEventListener('change', () => { readMappingUI(); rebuildDataset(); });
    $('#selComparison').addEventListener('change', () => {
      const c = state.mapping.comparisons[parseInt($('#selComparison').value, 10)];
      if (!c) return;
      state.mapping.fc = c.fc;
      state.mapping.p = c.p == null ? -1 : c.p;
      state.mapping.padj = c.padj == null ? -1 : c.padj;
      const st = VP.data.columnStats(state.table.rows, c.fc);
      state.mapping.fcScale = VP.data.detectFcScale(state.table.headers[c.fc], st);
      fillMappingUI();
      rebuildDataset();
    });

    /* --- thresholds --- */
    const setP = (p, fromSlider) => {
      p = clamp(p, 0, 1);
      state.thresholds.pCutoff = p;
      $('#outP').textContent = p < 1e-4 ? p.toExponential(1) : String(parseFloat(p.toPrecision(3)));
      $('#inpP').value = p;
      if (!fromSlider) $('#rngP').value = String(pToSlider(p));
      recompute();
    };
    $('#rngP').addEventListener('input', () => {
      const p = sliderToP(parseFloat($('#rngP').value));
      setP(parseFloat(p.toPrecision(2)), true);
    });
    $('#inpP').addEventListener('change', () => setP(parseFloat($('#inpP').value)));
    document.querySelectorAll('#pPresets .chip').forEach((c) => {
      c.addEventListener('click', () => setP(parseFloat(c.dataset.p)));
    });

    const setFc = (v, fromSlider) => {
      v = Math.max(0, v || 0);
      state.thresholds.fcCutoff = v;
      $('#outFc').textContent = v.toFixed(2);
      $('#inpFc').value = v;
      if (!fromSlider) $('#rngFc').value = String(Math.round(v * 100));
      $('#fcHint').textContent = v === 0
        ? 'No fold-change requirement — significance is decided by the p-value alone.'
        : '|log₂ FC| ≥ ' + v.toFixed(2) + ' is a ' + fmtNum(Math.pow(2, v), 2) + '-fold change.';
      recompute();
    };
    $('#rngFc').addEventListener('input', () => setFc(parseFloat($('#rngFc').value) / 100, true));
    $('#inpFc').addEventListener('change', () => setFc(parseFloat($('#inpFc').value)));
    document.querySelectorAll('#fcPresets .chip').forEach((c) => {
      c.addEventListener('click', () => setFc(parseFloat(c.dataset.fc)));
    });

    $('#selPType').addEventListener('change', () => {
      state.thresholds.useAdjusted = $('#selPType').value === 'padj';
      const yl = state.thresholds.useAdjusted ? '−log₁₀ adjusted p-value' : '−log₁₀ p-value';
      state.config.yLabel = yl;
      $('#inpYLabel').value = yl;
      recompute();
    });

    /* --- style --- */
    const fontSel = $('#selFont');
    VP.plot.PUB_FONTS.forEach((f) => {
      fontSel.appendChild(el('option', { value: f, text: f.split(',')[0].replace(/"/g, '') }));
    });
    fontSel.value = state.config.font.family;
    fontSel.addEventListener('change', () => { state.config.font.family = fontSel.value; render(); });

    const numBind = (id, apply) => {
      $('#' + id).addEventListener('input', () => {
        const v = parseFloat($('#' + id).value);
        if (isFinite(v)) { apply(v); render(); }
      });
    };
    numBind('inpTickSize', (v) => { state.config.font.tickSize = v; });
    numBind('inpAxisSize', (v) => { state.config.font.axisTitleSize = v; });
    numBind('inpLabelSize', (v) => { state.config.font.labelSize = v; });
    numBind('inpTitleSize', (v) => { state.config.font.titleSize = v; });
    numBind('inpWidth', (v) => { state.config.width = clamp(v, 200, 4000); updatePngHint(); });
    numBind('inpHeight', (v) => { state.config.height = clamp(v, 200, 4000); updatePngHint(); });

    $('#chkLabelBold').addEventListener('change', (e) => {
      state.config.font.labelWeight = e.target.checked ? 'bold' : 'normal'; render();
    });
    $('#chkLabelItalic').addEventListener('change', (e) => {
      state.config.font.labelItalic = e.target.checked; render();
    });

    $('#rngSize').addEventListener('input', () => {
      state.config.point.size = parseFloat($('#rngSize').value) / 10;
      $('#outSize').textContent = state.config.point.size.toFixed(1);
      render();
    });
    $('#rngOpacity').addEventListener('input', () => {
      state.config.point.opacity = parseFloat($('#rngOpacity').value) / 100;
      $('#outOpacity').textContent = state.config.point.opacity.toFixed(2);
      render();
    });
    $('#rngStroke').addEventListener('input', () => {
      state.config.point.strokeWidth = parseFloat($('#rngStroke').value) / 10;
      $('#outStroke').textContent = state.config.point.strokeWidth.toFixed(1);
      render();
    });

    const colorBind = (id, key) => {
      $('#' + id).addEventListener('input', () => { state.config.colors[key] = $('#' + id).value; render(); });
    };
    colorBind('colUp', 'up'); colorBind('colDown', 'down'); colorBind('colNs', 'ns');
    colorBind('colHighlight', 'highlight'); colorBind('colBg', 'background'); colorBind('colGrid', 'grid');

    const applyPalette = (name) => {
      Object.assign(state.config.colors, PALETTES[name]);
      state.config.label.haloColor = state.config.colors.background;
      syncControlsFromState();
      render();
    };
    $('#btnPalDefault').addEventListener('click', () => applyPalette('default'));
    $('#btnPalColorblind').addEventListener('click', () => applyPalette('colorblind'));
    $('#btnPalMono').addEventListener('click', () => applyPalette('mono'));

    const textBind = (id, key) => {
      $('#' + id).addEventListener('input', () => { state.config[key] = $('#' + id).value; render(); });
    };
    textBind('inpTitle', 'title'); textBind('inpXLabel', 'xLabel'); textBind('inpYLabel', 'yLabel');

    $('#selAxisStyle').addEventListener('change', (e) => { state.config.axisStyle = e.target.value; render(); });
    $('#selLegendPos').addEventListener('change', (e) => {
      const v = e.target.value;
      state.config.legend.show = v !== 'none';
      if (v !== 'none') state.config.legend.position = v;
      render();
    });
    const chkBind = (id, apply) => $('#' + id).addEventListener('change', (e) => { apply(e.target.checked); render(); });
    chkBind('chkGrid', (v) => { state.config.showGrid = v; });
    chkBind('chkThresholds', (v) => { state.config.showThresholds = v; });
    chkBind('chkSymmetric', (v) => { state.config.symmetricX = v; state.view = null; });
    chkBind('chkLegendCounts', (v) => { state.config.legend.showCounts = v; });
    chkBind('chkHalo', (v) => { state.config.label.halo = v; });
    chkBind('chkLeader', (v) => { state.config.label.leader = v; });

    /* --- protein list --- */
    $('#btnApplyList').addEventListener('click', () => applyList(true));
    $('#proteinList').addEventListener('input', debounce(() => applyList(false), 500));
    $('#btnClearList').addEventListener('click', () => {
      $('#proteinList').value = '';
      state.listMatched.clear();
      $('#matchReport').hidden = true;
      recompute();
    });
    $('#rngAutoLabel').addEventListener('input', () => {
      state.autoLabelN = parseInt($('#rngAutoLabel').value, 10);
      $('#outAutoLabel').textContent = String(state.autoLabelN);
      recompute();
    });
    $('#selLabelText').addEventListener('change', (e) => { state.labelTextMode = e.target.value; recompute(); });
    $('#btnResetLabelPos').addEventListener('click', () => { state.labelOffsets = {}; render(); });

    /* --- organism / library / GO --- */
    const orgSel = $('#selOrganism');
    VP.api.ORGANISMS.forEach((o) => orgSel.appendChild(el('option', { value: o.id, text: o.label })));
    orgSel.value = state.organism;
    orgSel.addEventListener('change', () => { state.organism = orgSel.value; });

    const libSel = $('#selLibrary'), enrichLibSel = $('#selEnrichLib');
    VP.api.CURATED_LIBRARIES.forEach((l) => {
      libSel.appendChild(el('option', { value: l.name, text: l.name.replace(/_/g, ' ') }));
      enrichLibSel.appendChild(el('option', { value: l.name, text: l.name.replace(/_/g, ' ') }));
    });
    // Replace with the live list when Enrichr can be reached.
    VP.api.listLibraries().then((list) => {
      if (!list || list.length < 5) return;
      [libSel, enrichLibSel].forEach((sel) => {
        const keep = sel.value;
        clear(sel);
        list.forEach((l) => sel.appendChild(el('option', {
          value: l.name,
          text: l.name.replace(/_/g, ' ') + (l.terms ? ' (' + l.terms.toLocaleString() + ')' : ''),
        })));
        sel.value = keep;
        if (!sel.value) sel.value = list[0].name;
      });
    }).catch(() => {});

    $('#selSource').addEventListener('change', () => {
      $('#libField').hidden = $('#selSource').value !== 'library';
    });
    $('#btnLoadLib').addEventListener('click', () => loadLibraryUI(libSel.value).catch(() => {}));
    $('#btnTermSearch').addEventListener('click', searchTerms);
    $('#inpTermSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchTerms(); });
    document.querySelectorAll('#termQuickPicks .chip').forEach((c) => {
      c.addEventListener('click', () => { $('#inpTermSearch').value = c.textContent; searchTerms(); });
    });
    $('#btnAddCustomCluster').addEventListener('click', () => {
      const name = $('#inpCustomName').value.trim() || 'Custom set';
      const terms = parseTerms($('#inpCustomGenes').value).map((t) => t.toUpperCase());
      if (!terms.length) { toast('Add some genes first.', 'error'); return; }
      addCluster({ name, genes: new Set(terms), accessions: new Set(terms), total: terms.length, source: 'custom' });
      $('#inpCustomName').value = ''; $('#inpCustomGenes').value = '';
    });

    /* --- enrichment --- */
    $('#selProvider').addEventListener('change', () => {
      const p = $('#selProvider').value;
      $('#gpSourcesField').hidden = p !== 'gprofiler';
      $('#enrichLibField').hidden = p === 'gprofiler';
    });
    document.querySelectorAll('#gpSources .chip').forEach((c) => {
      c.addEventListener('click', () => c.classList.toggle('on'));
    });
    $('#selEnrichSet').addEventListener('change', updateEnrichHint);
    $('#btnRunEnrich').addEventListener('click', runEnrichment);
    $('#enrichFilter').addEventListener('input', debounce(() => {
      state.enrich.filter = $('#enrichFilter').value;
      renderEnrichTable();
    }, 200));
    document.querySelectorAll('#enrichTable th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (state.enrich.sortKey === k) state.enrich.sortDir = state.enrich.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.enrich.sortKey = k; state.enrich.sortDir = (k === 'p_adjusted' || k === 'name' || k === 'source') ? 'asc' : 'desc'; }
        renderEnrichTable();
      });
    });
    $('#drawerHandle').addEventListener('click', () => {
      openDrawer($('#drawer').dataset.state !== 'open');
    });

    /* --- stage tools --- */
    $('#btnZoomIn').addEventListener('click', () => {
      if (state.geom) zoomAt(state.geom.plotX + state.geom.plotW / 2, state.geom.plotY + state.geom.plotH / 2, 1 / 1.3);
    });
    $('#btnZoomOut').addEventListener('click', () => {
      if (state.geom) zoomAt(state.geom.plotX + state.geom.plotW / 2, state.geom.plotY + state.geom.plotH / 2, 1.3);
    });
    $('#btnResetView').addEventListener('click', resetView);
    $('#btnModePan').addEventListener('click', () => setMode('pan'));
    $('#btnModeSelect').addEventListener('click', () => setMode('select'));

    /* --- export --- */
    $('#selPngScale').addEventListener('change', updatePngHint);
    $('#btnPng').addEventListener('click', () => exportPng(parseInt($('#selPngScale').value, 10)));
    $('#btnQuickPng').addEventListener('click', () => exportPng(parseInt($('#selPngScale').value, 10)));
    $('#btnSvg').addEventListener('click', exportSvg);
    $('#btnCsvAll').addEventListener('click', () => exportCsv(false));
    $('#btnCsvSig').addEventListener('click', () => exportCsv(true));
    $('#btnCsvEnrich').addEventListener('click', exportEnrichCsv);
    $('#btnSaveSession').addEventListener('click', saveSession);
    $('#btnLoadSession').addEventListener('click', () => $('#sessionInput').click());
    $('#sessionInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => restoreSession(String(rd.result));
      rd.readAsText(f);
    });
    $('#btnClearCache').addEventListener('click', () => {
      VP.api.clearCache();
      annotationFailed = false;
      toast('Cached annotations cleared.', 'ok');
    });

    /* --- help --- */
    $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
    $('#btnHelpClose').addEventListener('click', () => { $('#helpModal').hidden = true; });
    $('#helpModal').addEventListener('click', (e) => {
      if (e.target === $('#helpModal')) $('#helpModal').hidden = true;
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#helpModal').hidden = true; hideTooltip(); }
    });
  }

  function setMode(m) {
    state.mode = m;
    $('#btnModePan').classList.toggle('is-on', m === 'pan');
    $('#btnModeSelect').classList.toggle('is-on', m === 'select');
    setStatus(m === 'select' ? 'Drag a box to label every protein inside it' : 'Drag to pan · scroll to zoom · click a point to pin its label');
  }

  /* ======================= file handling ======================= */

  async function handleFile(file) {
    const name = file.name || 'file';
    setStatus('Reading ' + name + '…');
    try {
      if (/\.xlsx?$|\.xlsm$/i.test(name)) {
        const buf = await file.arrayBuffer();
        const wb = await VP.xlsx.read(buf);
        state.workbook = wb;
        const sel = $('#selSheet');
        clear(sel);
        wb.sheets.forEach((s, i) => {
          sel.appendChild(el('option', { value: String(i), text: s.name + '  (' + s.rows.length + ' rows)' }));
        });
        $('#sheetField').hidden = wb.sheets.length < 2;
        // Default to the sheet that actually looks like a results table.
        let best = 0, bestScore = -1;
        wb.sheets.forEach((s, i) => {
          const cols = s.rows.length ? Math.max(...s.rows.slice(0, 20).map((r) => r.length)) : 0;
          const score = s.rows.length * Math.min(cols, 40);
          if (score > bestScore) { bestScore = score; best = i; }
        });
        sel.value = String(best);
        const sheet = wb.sheets[best];
        if (!sheet || !sheet.rows.length) throw new Error('That worksheet is empty.');
        loadTable(VP.data.toTable(sheet.rows), name + (wb.sheets.length > 1 ? ' [' + sheet.name + ']' : ''));
      } else {
        const text = await file.text();
        const parsed = VP.data.parseDelimited(text);
        loadTable(VP.data.toTable(parsed.rows), name);
      }
      toast(name, 'ok', 'Loaded');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      notice('dataNotice', U.escapeHtml(msg), 'error');
      toast(msg, 'error', 'Could not read that file');
      setStatus('Load failed');
    }
  }

  /* ======================= boot ======================= */

  function boot() {
    bind();
    syncControlsFromState();
    setMode('pan');
    renderEnrichTable();
    window.addEventListener('resize', debounce(render, 120));
    // Web fonts change text metrics, so re-layout once they are ready.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.VP);
