/* =============================================================================
   plot.js - the volcano figure itself.

   draw() is a pure function of (surface, state): it makes the same calls
   whether it is painting the screen canvas, a 4x PNG or an SVG. Hit testing
   and label layout run off the same geometry, so what you hover is what you
   see and what you export.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const { niceTicks, fmtTick, clamp } = VP.util;
  const { measureText } = VP.surface;

  const PUB_FONTS = [
    'Arial, Helvetica, sans-serif',
    'Helvetica, Arial, sans-serif',
    '"Helvetica Neue", Helvetica, Arial, sans-serif',
    '"Arial Narrow", Arial, sans-serif',
    'Calibri, Carlito, sans-serif',
    '"Times New Roman", Times, serif',
    'Georgia, serif',
    '"Courier New", monospace',
    '"IBM Plex Sans", Arial, sans-serif',
    '"IBM Plex Mono", "Courier New", monospace',
  ];

  function defaultConfig() {
    return {
      width: 820,
      height: 620,
      title: '',
      xLabel: 'log₂ fold change',
      yLabel: '−log₁₀ p-value',

      font: {
        family: 'Arial, Helvetica, sans-serif',
        tickSize: 12,
        axisTitleSize: 14,
        titleSize: 17,
        labelSize: 11,
        labelWeight: 'normal',
        labelItalic: false,
      },

      point: { size: 3.2, opacity: 0.62, strokeWidth: 0, strokeColor: '#ffffff', nsScale: 0.85 },

      colors: {
        up: '#e34948',
        down: '#2a78d6',
        ns: '#b9b9b3',
        highlight: '#111111',
        background: '#ffffff',
        axis: '#33332f',
        text: '#1a1a18',
        grid: '#e9e9e4',
        threshold: '#8a8a82',
      },

      showGrid: true,
      showThresholds: true,
      thresholdDash: [5, 4],
      symmetricX: true,
      axisStyle: 'lines',            // 'lines' | 'box' | 'none'

      legend: { show: true, position: 'outside-right', showCounts: true, size: 12, float: null },

      label: {
        halo: true,
        haloColor: '#ffffff',
        leader: true,
        leaderColor: '#6d6d66',
        maxAuto: 0,                  // auto-label top-N by significance (0 = off)
        color: 'match',              // 'match' = follow the point colour
      },
    };
  }

  /* --- geometry ----------------------------------------------------------- */

  function dataExtent(records) {
    let x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of records) {
      if (r.x < x0) x0 = r.x;
      if (r.x > x1) x1 = r.x;
      if (r.y > y1) y1 = r.y;
    }
    if (!isFinite(x0)) { x0 = -1; x1 = 1; y1 = 1; }
    if (!isFinite(y1) || y1 <= 0) y1 = 1;
    return { x0, x1, y1 };
  }

  function autoDomain(state) {
    const ext = dataExtent(state.records);
    const cfg = state.config;
    let x0 = ext.x0, x1 = ext.x1;
    if (cfg.symmetricX) {
      const m = Math.max(Math.abs(x0), Math.abs(x1));
      x0 = -m; x1 = m;
    }
    const padX = (x1 - x0) * 0.06 || 1;
    const padY = ext.y1 * 0.07 || 0.5;
    return { x0: x0 - padX, x1: x1 + padX, y0: 0, y1: ext.y1 + padY };
  }

  function computeGeometry(state) {
    const cfg = state.config;
    const dom = state.view || autoDomain(state);

    const tickFont = { family: cfg.font.family, size: cfg.font.tickSize };
    const yT = niceTicks(dom.y0, dom.y1, 6);
    const xT = niceTicks(dom.x0, dom.x1, 7);

    // The left margin has to fit the widest y tick label plus the rotated axis
    // title, so the figure never clips its own axis.
    let maxYLabel = 0;
    for (const t of yT.ticks) maxYLabel = Math.max(maxYLabel, measureText(fmtTick(t, yT.step), tickFont));

    const hasTitle = !!(cfg.title && cfg.title.trim());
    const marginLeft = Math.ceil(maxYLabel + 10 + (cfg.yLabel ? cfg.font.axisTitleSize + 8 : 0) + 6);
    const marginBottom = Math.ceil(cfg.font.tickSize + 12 + (cfg.xLabel ? cfg.font.axisTitleSize + 8 : 0));
    const marginTop = Math.ceil(hasTitle ? cfg.font.titleSize + 18 : 14);
    let marginRight = 18;
    if (cfg.legend.show && cfg.legend.position === 'outside-right') {
      const ls = legendSize(state);
      if (ls) marginRight = Math.ceil(ls.boxW + 26);
    }

    const plotX = marginLeft;
    const plotY = marginTop;
    const plotW = Math.max(40, cfg.width - marginLeft - marginRight);
    const plotH = Math.max(40, cfg.height - marginTop - marginBottom);

    const sx = (v) => plotX + ((v - dom.x0) / (dom.x1 - dom.x0)) * plotW;
    const sy = (v) => plotY + plotH - ((v - dom.y0) / (dom.y1 - dom.y0)) * plotH;
    const ix = (px) => dom.x0 + ((px - plotX) / plotW) * (dom.x1 - dom.x0);
    const iy = (py) => dom.y0 + ((plotY + plotH - py) / plotH) * (dom.y1 - dom.y0);

    return { dom, plotX, plotY, plotW, plotH, sx, sy, ix, iy, xT, yT };
  }

  /* --- point styling ------------------------------------------------------ */

  /* A record can be flagged by several things at once. Resolution order:
     highlighted protein list > GO/pathway cluster > significance class. */
  function styleFor(rec, state) {
    const cfg = state.config;
    const base = cfg.point.size;
    let color = cfg.colors[rec.cls] || cfg.colors.ns;
    let shape = 'circle';
    let r = rec.cls === 'ns' ? base * cfg.point.nsScale : base;
    let priority = rec.cls === 'ns' ? 0 : 1;
    let opacity = cfg.point.opacity;
    let stroke = null, strokeWidth = 0, strokeOpacity = 1;
    let cluster = null;

    if (rec.clusters && rec.clusters.length) {
      cluster = rec.clusters[0];
      color = cluster.color;
      shape = cluster.shape || 'circle';
      r = base * 1.25;
      opacity = Math.min(1, cfg.point.opacity + 0.28);
      priority = 2;
    }
    if (cfg.point.strokeWidth > 0) {
      stroke = cfg.point.strokeColor;
      strokeWidth = cfg.point.strokeWidth;
      strokeOpacity = Math.min(1, opacity + 0.25);
    }
    if (rec.highlighted) {
      r = base * 1.55;
      opacity = 1;
      priority = 3;
      stroke = cfg.colors.highlight;
      strokeWidth = Math.max(cfg.point.strokeWidth, 1.4);
      strokeOpacity = 1;
    }
    return { color, shape, r, priority, opacity, stroke, strokeWidth, strokeOpacity, cluster };
  }

  /* --- labels ------------------------------------------------------------- */

  const CANDIDATES = [
    [1, -1], [1, 0], [-1, -1], [-1, 0], [0, -1], [1, 1], [-1, 1], [0, 1],
  ];

  /* A denser ring of directions for the crowded-plot pass. */
  const WIDE_CANDIDATES = (function () {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      out.push([Math.cos(a), Math.sin(a)]);
    }
    return out.concat(CANDIDATES);
  })();

  function rectsOverlap(a, b, pad) {
    const p = pad || 0;
    return !(a.x1 + p < b.x0 || b.x1 + p < a.x0 || a.y1 + p < b.y0 || b.y1 + p < a.y0);
  }

  /**
   * Place labels for the records in state.labelSet without overlapping each
   * other. Most-significant labels are placed first so, when the plot is
   * crowded, the important names get the good positions.
   */
  function layoutLabels(state, geom) {
    const cfg = state.config;
    const font = {
      family: cfg.font.family,
      size: cfg.font.labelSize,
      weight: cfg.font.labelWeight,
      italic: cfg.font.labelItalic,
    };
    const out = [];
    const placed = [];

    // The legend is opaque: it is both an occupied box and a hard no-go area.
    const reserved = [];
    const lg = legendLayout(state, geom);
    if (lg && lg.overlapsPlot) {
      reserved.push({ x0: lg.bx - 3, y0: lg.by - 3, x1: lg.bx + lg.boxW + 3, y1: lg.by + lg.boxH + 3 });
      placed.push(reserved[0]);
    }

    const items = [];
    state.records.forEach((rec) => {
      if (!rec.labelled) return;
      items.push(rec);
    });
    items.sort((a, b) => (b.highlighted ? 1 : 0) - (a.highlighted ? 1 : 0) || b.y - a.y);

    const halfH = font.size * 0.5;
    for (const rec of items) {
      const px = geom.sx(rec.x), py = geom.sy(rec.y);
      if (px < geom.plotX - 40 || px > geom.plotX + geom.plotW + 40 ||
          py < geom.plotY - 40 || py > geom.plotY + geom.plotH + 40) continue;

      const text = rec.labelText || rec.label;
      const w = measureText(text, font);
      const st = styleFor(rec, state);
      const gap = st.r + 4;

      const override = state.labelOffsets[rec.i];
      let best = null;

      if (override) {
        const cx = px + override.dx, cy = py + override.dy;
        best = { x: cx, y: cy, anchor: override.dx < -2 ? 'end' : override.dx > 2 ? 'start' : 'middle' };
      } else {
        // Candidate boxes, nearest ring first.
        const boxFor = (dx, dy, dist) => {
          const ax = px + dx * dist;
          const ay = py + dy * dist + (dy === 0 ? font.size * 0.35 : dy < 0 ? -2 : font.size * 0.85);
          const anchor = dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle';
          const x0 = anchor === 'start' ? ax : anchor === 'end' ? ax - w : ax - w / 2;
          return {
            x: ax, y: ay, anchor,
            box: { x0, x1: x0 + w, y0: ay - font.size * 0.8, y1: ay + font.size * 0.25 },
          };
        };
        const inBounds = (b) => b.x0 >= geom.plotX + 2 && b.x1 <= geom.plotX + geom.plotW - 2 &&
          b.y0 >= geom.plotY + 2 && b.y1 <= geom.plotY + geom.plotH - 2;
        const clashes = (b, list) => {
          for (const q of list) if (rectsOverlap(b, q, 1.5)) return true;
          return false;
        };

        // Pass 1: inside the axes, clear of every other label and the legend.
        for (let ring = 0; ring < 4 && !best; ring++) {
          const dist = gap + ring * (font.size + 3);
          for (const [dx, dy] of CANDIDATES) {
            const c = boxFor(dx, dy, dist);
            if (!inBounds(c.box) || clashes(c.box, placed)) continue;
            best = c;
            break;
          }
        }
        // Pass 2: crowded plot - accept overlapping another label, but never
        // the legend, which is opaque and would erase the name entirely. Search
        // wider here (more angles, more rings) so this almost always succeeds.
        if (!best) {
          for (let ring = 0; ring < 8 && !best; ring++) {
            const dist = gap + ring * (font.size + 3);
            for (const [dx, dy] of WIDE_CANDIDATES) {
              const c = boxFor(dx, dy, dist);
              if (!inBounds(c.box) || clashes(c.box, reserved)) continue;
              best = c;
              break;
            }
          }
        }
        // Pass 3: keep the label rather than dropping the protein - clamped
        // inside the axes, then nudged clear of any reserved box.
        if (!best) {
          const room = px + gap + w <= geom.plotX + geom.plotW - 2;
          const anchor = room ? 'start' : 'end';
          let ax = room ? px + gap : px - gap;
          let ay = clamp(py - 2, geom.plotY + font.size + 2, geom.plotY + geom.plotH - 3);
          let x0 = anchor === 'start' ? ax : ax - w;
          if (x0 < geom.plotX + 2) { x0 = geom.plotX + 2; ax = anchor === 'start' ? x0 : x0 + w; }
          let box = { x0, x1: x0 + w, y0: ay - font.size * 0.8, y1: ay + font.size * 0.25 };

          for (const q of reserved) {
            if (!rectsOverlap(box, q, 1.5)) continue;
            // Slide below the reserved box, or above it if there is no room.
            const below = q.y1 + font.size + 2;
            const above = q.y0 - 4;
            const fitsBelow = below + font.size * 0.25 <= geom.plotY + geom.plotH - 3;
            ay = fitsBelow ? below : Math.max(geom.plotY + font.size + 2, above);
            box = { x0, x1: x0 + w, y0: ay - font.size * 0.8, y1: ay + font.size * 0.25 };
          }
          best = { x: ax, y: ay, anchor, box };
        }
      }
      if (best.box) placed.push(best.box);

      const st2 = styleFor(rec, state);
      const dist = Math.hypot(best.x - px, best.y - halfH - py);
      out.push({
        rec, text, x: best.x, y: best.y, anchor: best.anchor,
        px, py, r: st2.r,
        color: cfg.label.color === 'match' ? (rec.highlighted ? cfg.colors.highlight : st2.color) : cfg.label.color,
        leader: cfg.label.leader && dist > st2.r + font.size * 1.1,
      });
    }
    return { labels: out, font };
  }

  /* --- draw --------------------------------------------------------------- */

  function draw(surface, state, geom) {
    const cfg = state.config;
    geom = geom || computeGeometry(state);
    const { plotX, plotY, plotW, plotH, sx, sy, xT, yT, dom } = geom;

    surface.rect(0, 0, cfg.width, cfg.height, { fill: cfg.colors.background });

    /* grid ---------------------------------------------------------------- */
    surface.group('grid');
    if (cfg.showGrid) {
      const gs = { stroke: cfg.colors.grid, strokeWidth: 1 };
      for (const t of xT.ticks) {
        const x = sx(t);
        if (x < plotX - 0.5 || x > plotX + plotW + 0.5) continue;
        surface.line(x, plotY, x, plotY + plotH, gs);
      }
      for (const t of yT.ticks) {
        const y = sy(t);
        if (y < plotY - 0.5 || y > plotY + plotH + 0.5) continue;
        surface.line(plotX, y, plotX + plotW, y, gs);
      }
    }
    surface.endGroup();

    /* threshold guides ----------------------------------------------------- */
    surface.group('thresholds');
    if (cfg.showThresholds) {
      const ts = { stroke: cfg.colors.threshold, strokeWidth: 1.2, dash: cfg.thresholdDash };
      const fc = Math.abs(state.thresholds.fcCutoff);
      if (fc > 0) {
        for (const v of [-fc, fc]) {
          const x = sx(v);
          if (x >= plotX && x <= plotX + plotW) surface.line(x, plotY, x, plotY + plotH, ts);
        }
      }
      const yCut = -Math.log10(state.thresholds.pCutoff);
      const y = sy(yCut);
      if (isFinite(y) && y >= plotY && y <= plotY + plotH) surface.line(plotX, y, plotX + plotW, y, ts);
    }
    surface.endGroup();

    /* points --------------------------------------------------------------- */
    surface.clip(plotX, plotY, plotW, plotH);
    surface.group('points');

    const buckets = new Map();
    const pad = 8;
    for (const rec of state.records) {
      if (rec.hidden) continue;
      const px = sx(rec.x), py = sy(rec.y);
      // Cull off-screen points: panning a 10k-protein plot stays smooth.
      if (px < plotX - pad || px > plotX + plotW + pad || py < plotY - pad || py > plotY + plotH + pad) continue;
      const st = styleFor(rec, state);
      const key = st.priority + '|' + st.color + '|' + st.shape + '|' + st.r.toFixed(2) + '|' +
        st.opacity.toFixed(3) + '|' + (st.stroke || '') + '|' + st.strokeWidth;
      let b = buckets.get(key);
      if (!b) {
        b = {
          style: {
            shape: st.shape, fill: st.color, fillOpacity: st.opacity,
            stroke: st.stroke, strokeWidth: st.strokeWidth, strokeOpacity: st.strokeOpacity,
            label: st.cluster ? st.cluster.name : rec.cls,
          },
          priority: st.priority, pts: [],
        };
        buckets.set(key, b);
      }
      b.pts.push({ x: px, y: py, r: st.r });
    }
    Array.from(buckets.values())
      .sort((a, b) => a.priority - b.priority)
      .forEach((b) => surface.markers(b.pts, b.style));

    surface.endGroup();

    /* labels (inside the clip so they never spill past the axes) ----------- */
    const laid = layoutLabels(state, geom);
    surface.group('labels');
    for (const L of laid.labels) {
      if (L.leader) {
        const dx = L.x - L.px, dy = (L.y - laid.font.size * 0.35) - L.py;
        const len = Math.hypot(dx, dy) || 1;
        const startX = L.px + (dx / len) * (L.r + 1.5);
        const startY = L.py + (dy / len) * (L.r + 1.5);
        const endX = L.x - (dx / len) * 2;
        const endY = L.y - laid.font.size * 0.35 - (dy / len) * 2;
        surface.line(startX, startY, endX, endY, {
          stroke: cfg.label.leaderColor, strokeWidth: 0.8, opacity: 0.9,
        });
      }
      surface.text(L.x, L.y, L.text, {
        family: laid.font.family, size: laid.font.size, weight: laid.font.weight,
        italic: laid.font.italic, fill: L.color, anchor: L.anchor,
        halo: cfg.label.halo ? cfg.label.haloColor : null, haloWidth: 3,
      });
    }
    surface.endGroup();
    surface.unclip();

    /* axes ----------------------------------------------------------------- */
    surface.group('axes');
    const axisStroke = { stroke: cfg.colors.axis, strokeWidth: 1.1 };
    if (cfg.axisStyle === 'box') {
      surface.rect(plotX, plotY, plotW, plotH, { stroke: cfg.colors.axis, strokeWidth: 1.1 });
    } else if (cfg.axisStyle === 'lines') {
      surface.line(plotX, plotY + plotH, plotX + plotW, plotY + plotH, axisStroke);
      surface.line(plotX, plotY, plotX, plotY + plotH, axisStroke);
    }

    const tickStyle = {
      family: cfg.font.family, size: cfg.font.tickSize, fill: cfg.colors.text,
    };
    for (const t of xT.ticks) {
      const x = sx(t);
      if (x < plotX - 0.5 || x > plotX + plotW + 0.5) continue;
      if (cfg.axisStyle !== 'none') surface.line(x, plotY + plotH, x, plotY + plotH + 4, axisStroke);
      surface.text(x, plotY + plotH + 6, fmtTick(t, xT.step), { ...tickStyle, anchor: 'middle', baseline: 'top' });
    }
    for (const t of yT.ticks) {
      const y = sy(t);
      if (y < plotY - 0.5 || y > plotY + plotH + 0.5) continue;
      if (cfg.axisStyle !== 'none') surface.line(plotX - 4, y, plotX, y, axisStroke);
      surface.text(plotX - 7, y, fmtTick(t, yT.step), { ...tickStyle, anchor: 'end', baseline: 'middle' });
    }

    if (cfg.xLabel) {
      surface.text(plotX + plotW / 2, cfg.height - 4, cfg.xLabel, {
        family: cfg.font.family, size: cfg.font.axisTitleSize, fill: cfg.colors.text,
        anchor: 'middle', baseline: 'bottom',
      });
    }
    if (cfg.yLabel) {
      surface.text(12, plotY + plotH / 2, cfg.yLabel, {
        family: cfg.font.family, size: cfg.font.axisTitleSize, fill: cfg.colors.text,
        anchor: 'middle', baseline: 'top', rotate: -90,
      });
    }
    if (cfg.title && cfg.title.trim()) {
      surface.text(plotX + plotW / 2, plotY - 10, cfg.title, {
        family: cfg.font.family, size: cfg.font.titleSize, weight: '600',
        fill: cfg.colors.text, anchor: 'middle', baseline: 'bottom',
      });
    }
    surface.endGroup();

    /* legend --------------------------------------------------------------- */
    if (cfg.legend.show) drawLegend(surface, state, geom);

    return geom;
  }

  function legendEntries(state) {
    const cfg = state.config;
    const c = state.counts || { up: 0, down: 0, ns: 0 };
    const out = [
      { label: 'Up', color: cfg.colors.up, shape: 'circle', n: c.up },
      { label: 'Down', color: cfg.colors.down, shape: 'circle', n: c.down },
      { label: 'Not significant', color: cfg.colors.ns, shape: 'circle', n: c.ns },
    ];
    for (const cl of state.clusters) {
      if (!cl.visible || !cl.matched) continue;
      out.push({ label: cl.name, color: cl.color, shape: cl.shape, n: cl.matched });
    }
    return out;
  }

  /* Legend size depends only on its contents, so it can be measured before the
     plot rectangle exists - which is what lets an outside-right legend reserve
     margin without a circular dependency. */
  function legendSize(state) {
    const cfg = state.config;
    if (!cfg.legend.show) return null;
    const entries = legendEntries(state);
    if (!entries.length) return null;

    const size = cfg.legend.size;
    const font = { family: cfg.font.family, size };
    const rowH = size + 6;
    const padBox = 8;
    const swatch = Math.max(4, cfg.point.size * 1.25);

    let maxW = 0;
    const texts = entries.map((e) => {
      const t = cfg.legend.showCounts ? e.label + '  (' + e.n.toLocaleString() + ')' : e.label;
      maxW = Math.max(maxW, measureText(t, font));
      return t;
    });
    return {
      entries, texts, size, rowH, padBox, swatch,
      boxW: maxW + swatch * 2 + padBox * 2 + 8,
      boxH: entries.length * rowH + padBox * 2 - 4,
    };
  }

  /* Where that box actually sits, given the plot rectangle. */
  function legendLayout(state, geom) {
    const L = legendSize(state);
    if (!L) return null;
    const cfg = state.config;
    const pos = cfg.legend.position;
    const inset = 10;
    let bx, by;

    if (pos === 'outside-right') {
      bx = geom.plotX + geom.plotW + 14;
      by = geom.plotY;
    } else if (pos === 'floating') {
      const f = cfg.legend.float;
      bx = f ? f.x : geom.plotX + geom.plotW - L.boxW - inset;
      by = f ? f.y : geom.plotY + inset;
      // Keep a dragged legend on the page even after a resize.
      bx = clamp(bx, 2, Math.max(2, cfg.width - L.boxW - 2));
      by = clamp(by, 2, Math.max(2, cfg.height - L.boxH - 2));
    } else {
      bx = pos === 'top-left' || pos === 'bottom-left'
        ? geom.plotX + inset
        : geom.plotX + geom.plotW - L.boxW - inset;
      by = pos === 'bottom-right' || pos === 'bottom-left'
        ? geom.plotY + geom.plotH - L.boxH - inset
        : geom.plotY + inset;
    }
    L.bx = bx;
    L.by = by;
    // Only a legend drawn over the plot competes with the data for space.
    L.overlapsPlot = pos !== 'outside-right';
    return L;
  }

  function drawLegend(surface, state, geom) {
    const cfg = state.config;
    const L = legendLayout(state, geom);
    if (!L) return;
    const { entries, texts, size, rowH, padBox, swatch, boxW, boxH, bx, by } = L;

    surface.group('legend');
    surface.rect(bx, by, boxW, boxH, {
      fill: cfg.colors.background, fillOpacity: 1,
      stroke: cfg.colors.grid, strokeWidth: 1,
    });
    if (state.legendHover) {
      // Transient, screen-only: exports clear the flag first.
      surface.rect(bx - 3, by - 3, boxW + 6, boxH + 6, {
        stroke: '#e8a33c', strokeWidth: 1.2, dash: [4, 3],
      });
      for (let i = 0; i < 3; i++) {
        surface.line(bx + 4, by + 5 + i * 3, bx + 10, by + 5 + i * 3, { stroke: '#c9922f', strokeWidth: 1 });
      }
    }
    entries.forEach((e, i) => {
      const cy = by + padBox + i * rowH + size * 0.4;
      surface.markers([{ x: bx + padBox + swatch, y: cy, r: swatch }], {
        shape: e.shape, fill: e.color, fillOpacity: 0.95,
      });
      surface.text(bx + padBox + swatch * 2 + 8, cy, texts[i], {
        family: cfg.font.family, size, fill: cfg.colors.text, baseline: 'middle',
      });
    });
    surface.endGroup();
  }

  /* --- hit testing -------------------------------------------------------- */

  /* A uniform grid over screen space. Rebuilt per render; queried on every
     mousemove, so it has to be cheap in both directions. */
  function buildIndex(state, geom) {
    const cell = 18;
    const cols = Math.ceil(geom.plotW / cell) + 2;
    const rows = Math.ceil(geom.plotH / cell) + 2;
    const grid = new Map();
    const pts = [];
    for (const rec of state.records) {
      if (rec.hidden) continue;
      const px = geom.sx(rec.x), py = geom.sy(rec.y);
      if (px < geom.plotX - 6 || px > geom.plotX + geom.plotW + 6 ||
          py < geom.plotY - 6 || py > geom.plotY + geom.plotH + 6) continue;
      const st = styleFor(rec, state);
      const idx = pts.length;
      pts.push({ rec, px, py, r: st.r, priority: st.priority });
      const cx = Math.floor((px - geom.plotX) / cell) + 1;
      const cy = Math.floor((py - geom.plotY) / cell) + 1;
      const key = cy * cols + cx;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(idx);
    }
    return { grid, pts, cell, cols, rows, plotX: geom.plotX, plotY: geom.plotY };
  }

  function hitTest(index, px, py, tolerance) {
    if (!index) return null;
    const tol = tolerance == null ? 7 : tolerance;
    const cx = Math.floor((px - index.plotX) / index.cell) + 1;
    const cy = Math.floor((py - index.plotY) / index.cell) + 1;
    let best = null, bestScore = Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const list = index.grid.get((cy + j) * index.cols + (cx + i));
        if (!list) continue;
        for (const idx of list) {
          const p = index.pts[idx];
          const d = Math.hypot(p.px - px, p.py - py);
          if (d > p.r + tol) continue;
          // Points drawn on top win ties, matching what the eye picks.
          const score = d - p.priority * 3;
          if (score < bestScore) { bestScore = score; best = p; }
        }
      }
    }
    return best;
  }

  /* Every point inside a screen-space rectangle (box select). */
  function pointsInRect(index, x0, y0, x1, y1) {
    const out = [];
    if (!index) return out;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    for (const p of index.pts) {
      if (p.px >= ax && p.px <= bx && p.py >= ay && p.py <= by) out.push(p.rec);
    }
    return out;
  }

  VP.plot = {
    defaultConfig, computeGeometry, autoDomain, draw, layoutLabels,
    buildIndex, hitTest, pointsInRect, styleFor, PUB_FONTS, legendEntries, legendLayout, legendSize,
  };
})(window.VP);
