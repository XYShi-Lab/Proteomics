/* =============================================================================
   network.js - an enrichment map: the pathway network beside the results table.

   Enrichment output is a ranked list, but the terms in it are not independent -
   "mitochondrial matrix", "mitochondrion" and "oxidative phosphorylation" are
   largely the same proteins reported three times. Drawing terms as nodes and
   their shared genes as edges collapses that redundancy into visible themes,
   the way STRING or Cytoscape's EnrichmentMap does.

   Everything is computed locally from the gene lists the enrichment already
   returned - no extra service, and it works with the built-in engine offline.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  /* Node colour by evidence source, so the network reads as a legend of its own. */
  const SOURCE_COLORS = [
    ['GO:BP', '#2a78d6'], ['GO:CC', '#1baf7a'], ['GO:MF', '#4a3aa7'],
    ['KEGG', '#eb6834'], ['REAC', '#e34948'], ['Reactome', '#e34948'],
    ['WP', '#eda100'], ['WikiPathway', '#eda100'], ['CORUM', '#8a4b9e'],
    ['Cellular_Component', '#1baf7a'], ['Biological_Process', '#2a78d6'],
    ['Molecular_Function', '#4a3aa7'], ['Hallmark', '#e87ba4'],
  ];

  function sourceColor(source) {
    const s = String(source || '');
    for (const [key, col] of SOURCE_COLORS) if (s.indexOf(key) >= 0) return col;
    return '#6d6f66';
  }

  /**
   * Build the graph.
   * @param {Array} results enrichment rows (need .genes to get edges)
   * @param {object} opts { maxNodes, minJaccard, colors }
   *   colors: Map termId -> {color, shape}, so a term already overlaid on the
   *   volcano keeps the colour it has there.
   */
  function build(results, opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes || 60;
    const minJ = opts.minJaccard == null ? 0.25 : opts.minJaccard;
    const colors = opts.colors || null;

    const rows = results
      .filter((r) => r && r.name)
      .slice()
      .sort((a, b) => (a.p_adjusted != null ? a.p_adjusted : a.p_value) -
                      (b.p_adjusted != null ? b.p_adjusted : b.p_value))
      .slice(0, maxNodes);

    const nodes = rows.map((r, i) => {
      const genes = new Set((r.genes || []).map((g) => String(g).toUpperCase()));
      const p = r.p_adjusted != null ? r.p_adjusted : r.p_value;
      return {
        i,
        row: r,
        id: r.id || r.name,
        name: r.name,
        source: r.source,
        genes,
        hits: r.intersection_size != null ? r.intersection_size : genes.size,
        p,
        score: p > 0 ? -Math.log10(p) : 300,
        color: (colors && colors.get(r.id) && colors.get(r.id).color) || sourceColor(r.source),
        x: 0, y: 0, vx: 0, vy: 0, r: 6,
      };
    });

    // Radius by hit count, on a square-root scale so area tracks the count.
    let maxHits = 1;
    for (const n of nodes) maxHits = Math.max(maxHits, n.hits || 1);
    for (const n of nodes) {
      n.r = 5 + 13 * Math.sqrt((n.hits || 1) / maxHits);
    }

    const edges = [];
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const A = nodes[a].genes, B = nodes[b].genes;
        if (!A.size || !B.size) continue;
        let inter = 0;
        const small = A.size <= B.size ? A : B;
        const big = A.size <= B.size ? B : A;
        for (const g of small) if (big.has(g)) inter++;
        if (!inter) continue;
        const jaccard = inter / (A.size + B.size - inter);
        if (jaccard < minJ) continue;
        edges.push({ a, b, w: jaccard, inter });
      }
    }
    return { nodes, edges, truncated: results.length > rows.length };
  }

  /**
   * Fruchterman-Reingold layout. n <= 60 here, so the O(n^2) repulsion pass is
   * cheaper than the bookkeeping any approximation would need.
   */
  function layout(graph, width, height, iterations) {
    const nodes = graph.nodes;
    const n = nodes.length;
    if (!n) return graph;
    const iters = iterations || 320;
    const area = width * height;
    const k = Math.sqrt(area / n) * 0.55;

    // Deterministic ring start: same results always give the same picture.
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const rad = Math.min(width, height) * (0.18 + 0.22 * ((i % 3) / 2));
      nodes[i].x = width / 2 + Math.cos(a) * rad;
      nodes[i].y = height / 2 + Math.sin(a) * rad;
    }

    let temp = Math.min(width, height) * 0.16;
    const cool = temp / (iters + 1);

    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) { nodes[i].vx = 0; nodes[i].vy = 0; }

      // Beyond this range nodes stop pushing each other. Without a cutoff,
      // unconnected term groups repel across the whole pane and the graph ends
      // up as small islands separated by dead space.
      const cutoff = k * 2.6;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = (i % 7) - 3 + 0.5; dy = (j % 5) - 2 + 0.5; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const touching = nodes[i].r + nodes[j].r + 6;
          if (d > cutoff && d > touching) continue;
          // Repulsion, boosted close in so discs do not sit on top of each other.
          const rep = (k * k) / d + (nodes[i].r + nodes[j].r) * 6 / d;
          const fx = (dx / d) * rep, fy = (dy / d) * rep;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }

      for (const e of graph.edges) {
        const A = nodes[e.a], B = nodes[e.b];
        const dx = A.x - B.x, dy = A.y - B.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const att = ((d * d) / k) * (0.35 + e.w);
        const fx = (dx / d) * att, fy = (dy / d) * att;
        A.vx -= fx; A.vy -= fy;
        B.vx += fx; B.vy += fy;
      }

      // Pull to centre: with the repulsion cutoff above, this is what keeps
      // separate themes as neighbouring clusters rather than distant islands.
      for (const nd of nodes) {
        nd.vx += (width / 2 - nd.x) * 0.045;
        nd.vy += (height / 2 - nd.y) * 0.045;
      }

      for (const nd of nodes) {
        const d = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy) || 1;
        const step = Math.min(d, temp);
        nd.x += (nd.vx / d) * step;
        nd.y += (nd.vy / d) * step;
        nd.x = Math.max(nd.r + 2, Math.min(width - nd.r - 2, nd.x));
        nd.y = Math.max(nd.r + 2, Math.min(height - nd.r - 2, nd.y));
      }
      temp -= cool;
    }
    graph.layoutW = width;
    graph.layoutH = height;
    return graph;
  }

  /** Scale the laid-out graph to fill the viewport with a margin. */
  function fit(graph, width, height, pad) {
    const nodes = graph.nodes;
    if (!nodes.length) return { k: 1, tx: 0, ty: 0 };
    const p = pad == null ? 26 : pad;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const k = Math.min((width - p * 2) / w, (height - p * 2) / h);
    return {
      k,
      tx: (width - w * k) / 2 - x0 * k,
      ty: (height - h * k) / 2 - y0 * k,
    };
  }

  function draw(ctx, graph, view, opts) {
    opts = opts || {};
    const dpr = opts.dpr || 1;
    const light = opts.theme !== 'dark';
    const bg = opts.background || (light ? '#ffffff' : '#131413');
    const inkStrong = light ? '#1a1a18' : '#ffffff';
    const inkSoft = light ? '#55564f' : '#c9cac1';
    const edgeInk = light ? '0,0,0' : '255,255,255';

    const W = ctx.canvas.width / dpr, H = ctx.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (!graph || !graph.nodes.length) return;

    const { k, tx, ty } = view;
    const X = (v) => v * k + tx;
    const Y = (v) => v * k + ty;

    // Edges first, weight-scaled so strong overlaps read as thicker ties.
    ctx.lineCap = 'round';
    for (const e of graph.edges) {
      const A = graph.nodes[e.a], B = graph.nodes[e.b];
      ctx.strokeStyle = 'rgba(' + edgeInk + ',' + (0.12 + e.w * 0.4).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.6, e.w * 5 * k);
      ctx.beginPath();
      ctx.moveTo(X(A.x), Y(A.y));
      ctx.lineTo(X(B.x), Y(B.y));
      ctx.stroke();
    }

    for (const n of graph.nodes) {
      const r = Math.max(2, n.r * k);
      const isSel = opts.selected && opts.selected.has(n.id);
      ctx.beginPath();
      ctx.arc(X(n.x), Y(n.y), r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.globalAlpha = n === opts.hover ? 1 : 0.86;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = isSel ? 2.5 : (n === opts.hover ? 2 : 1);
      ctx.strokeStyle = isSel
        ? (light ? '#111111' : '#4ec9b0')
        : (n === opts.hover ? inkStrong : (light ? 'rgba(0,0,0,.32)' : 'rgba(0,0,0,.45)'));
      ctx.stroke();
    }

    // Label the nodes there is room for: biggest first, skipping collisions.
    const font = (opts.fontSize || 10.5);
    ctx.font = '500 ' + font + 'px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    const order = graph.nodes.slice().sort((a, b) => b.r - a.r);
    for (const n of order) {
      const r = Math.max(2, n.r * k);
      let text = n.name.replace(/\s*\(GO:\d+\)\s*$/, '');
      if (text.length > 30) text = text.slice(0, 29) + '…';
      const w = ctx.measureText(text).width;
      const cx = X(n.x), cy = Y(n.y) + r + font * 0.9;
      const box = { x0: cx - w / 2 - 2, x1: cx + w / 2 + 2, y0: cy - font * 0.7, y1: cy + font * 0.7 };
      if (box.x0 < 0 || box.x1 > W || box.y1 > H) continue;
      let clash = false;
      for (const q of placed) {
        if (!(box.x1 < q.x0 || q.x1 < box.x0 || box.y1 < q.y0 || q.y1 < box.y0)) { clash = true; break; }
      }
      if (clash && n !== opts.hover) continue;
      placed.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, cx, cy);
      ctx.fillStyle = n === opts.hover ? inkStrong : inkSoft;
      ctx.fillText(text, cx, cy);
    }
  }

  function nodeAt(graph, view, px, py) {
    if (!graph) return null;
    const { k, tx, ty } = view;
    let best = null, bestD = Infinity;
    for (const n of graph.nodes) {
      const dx = (n.x * k + tx) - px;
      const dy = (n.y * k + ty) - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = Math.max(4, n.r * k);
      if (d <= r + 3 && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  VP.network = { build, layout, fit, draw, nodeAt, sourceColor };
})(window.VP);
