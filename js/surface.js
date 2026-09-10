/* =============================================================================
   surface.js - one drawing API, two back ends.

   The figure is drawn exactly once per frame through this interface. A canvas
   back end paints the screen (and the PNG export, at any scale factor); an SVG
   back end writes vector output for Illustrator/Inkscape. Because both consume
   the identical draw calls, the exported figure is the figure on screen - no
   second, drifting implementation of the plot.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const { rgba } = VP.util;

  /* Baselines are resolved to an explicit dy here, and both back ends draw on
     the alphabetic baseline, so text lands on the same pixel in PNG and SVG. */
  function baselineDy(baseline, size) {
    switch (baseline) {
      case 'top': return size * 0.8;
      case 'middle': return size * 0.32;
      case 'bottom': return -size * 0.2;
      default: return 0;
    }
  }

  function fontString(st) {
    const style = st.italic ? 'italic ' : '';
    const weight = st.weight ? st.weight + ' ' : '';
    return style + weight + (st.size || 12) + 'px ' + (st.family || 'sans-serif');
  }

  const ANCHOR_SVG = { start: 'start', middle: 'middle', end: 'end' };

  /* --- shared marker geometry -------------------------------------------- */

  /* Radius r is the "visual radius"; each shape is normalised so different
     shapes at the same size read as the same weight on the page. */
  function markerPath(shape, x, y, r) {
    switch (shape) {
      case 'square': {
        const a = r * 0.886;
        return [['M', x - a, y - a], ['L', x + a, y - a], ['L', x + a, y + a], ['L', x - a, y + a], ['Z']];
      }
      case 'triangle': {
        const a = r * 1.35;
        return [['M', x, y - a], ['L', x + a * 0.866, y + a * 0.5], ['L', x - a * 0.866, y + a * 0.5], ['Z']];
      }
      case 'diamond': {
        const a = r * 1.25;
        return [['M', x, y - a], ['L', x + a, y], ['L', x, y + a], ['L', x - a, y], ['Z']];
      }
      case 'triangle-down': {
        const a = r * 1.35;
        return [['M', x, y + a], ['L', x + a * 0.866, y - a * 0.5], ['L', x - a * 0.866, y - a * 0.5], ['Z']];
      }
      case 'cross': {
        const a = r * 1.2, w = r * 0.42;
        return [
          ['M', x - w, y - a], ['L', x + w, y - a], ['L', x + w, y - w], ['L', x + a, y - w],
          ['L', x + a, y + w], ['L', x + w, y + w], ['L', x + w, y + a], ['L', x - w, y + a],
          ['L', x - w, y + w], ['L', x - a, y + w], ['L', x - a, y - w], ['L', x - w, y - w], ['Z'],
        ];
      }
      default: return null; // circle
    }
  }

  const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'triangle-down', 'cross'];

  /* --- canvas back end ---------------------------------------------------- */

  function canvasSurface(ctx, scale) {
    const k = scale || 1;
    const S = (v) => v * k;

    function applyFill(st) {
      ctx.fillStyle = st.fillOpacity != null && st.fillOpacity < 1
        ? rgba(st.fill, st.fillOpacity) : st.fill;
    }
    function applyStroke(st) {
      ctx.strokeStyle = st.strokeOpacity != null && st.strokeOpacity < 1
        ? rgba(st.stroke, st.strokeOpacity) : st.stroke;
      ctx.lineWidth = S(st.strokeWidth == null ? 1 : st.strokeWidth);
      ctx.setLineDash((st.dash || []).map(S));
      ctx.lineCap = st.cap || 'butt';
      ctx.lineJoin = 'round';
    }

    return {
      kind: 'canvas',
      scale: k,

      rect(x, y, w, h, st) {
        st = st || {};
        if (st.fill) { applyFill(st); ctx.fillRect(S(x), S(y), S(w), S(h)); }
        if (st.stroke) { applyStroke(st); ctx.strokeRect(S(x), S(y), S(w), S(h)); ctx.setLineDash([]); }
      },

      line(x1, y1, x2, y2, st) {
        if (!st || !st.stroke) return;
        applyStroke(st);
        ctx.beginPath();
        ctx.moveTo(S(x1), S(y1));
        ctx.lineTo(S(x2), S(y2));
        ctx.stroke();
        ctx.setLineDash([]);
      },

      polyline(pts, st) {
        if (!st || !st.stroke || pts.length < 2) return;
        applyStroke(st);
        ctx.beginPath();
        ctx.moveTo(S(pts[0][0]), S(pts[0][1]));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(S(pts[i][0]), S(pts[i][1]));
        ctx.stroke();
        ctx.setLineDash([]);
      },

      /* Draw a whole bucket of identically-styled marks in one path - this is
         what keeps a 10,000-protein volcano interactive while panning. */
      markers(pts, st) {
        if (!pts.length) return;
        const shape = st.shape || 'circle';
        const stroked = st.stroke && st.strokeWidth > 0;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const x = S(p.x), y = S(p.y), r = S(p.r);
          if (shape === 'circle') {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          } else {
            const path = markerPath(shape, x, y, r);
            for (const seg of path) {
              if (seg[0] === 'M') ctx.moveTo(seg[1], seg[2]);
              else if (seg[0] === 'L') ctx.lineTo(seg[1], seg[2]);
              else ctx.closePath();
            }
          }
        }
        if (st.fill) { applyFill(st); ctx.fill(); }
        if (stroked) { applyStroke(st); ctx.stroke(); ctx.setLineDash([]); }
      },

      text(x, y, str, st) {
        st = st || {};
        ctx.save();
        ctx.font = fontString({ ...st, size: (st.size || 12) * k });
        ctx.textAlign = st.anchor || 'start';
        ctx.textBaseline = 'alphabetic';
        const dy = baselineDy(st.baseline, (st.size || 12) * k);
        const px = S(x), py = S(y) + dy;
        if (st.rotate) {
          ctx.translate(px, py);
          ctx.rotate(st.rotate * Math.PI / 180);
          ctx.translate(-px, -py);
        }
        if (st.halo) {
          ctx.lineWidth = S(st.haloWidth || 3);
          ctx.strokeStyle = st.halo;
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeText(str, px, py);
        }
        ctx.fillStyle = st.opacity != null && st.opacity < 1 ? rgba(st.fill || '#000', st.opacity) : (st.fill || '#000');
        ctx.fillText(str, px, py);
        ctx.restore();
      },

      clip(x, y, w, h) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(S(x), S(y), S(w), S(h));
        ctx.clip();
      },
      unclip() { ctx.restore(); },
      group() {}, endGroup() {},
    };
  }

  /* --- SVG back end ------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }
  const n = (v) => (Math.round(v * 100) / 100);

  function svgSurface(width, height) {
    const parts = [];
    let clipId = 0;
    const defs = [];

    function styleAttrs(st, forFill) {
      let a = '';
      if (forFill) {
        a += ' fill="' + (st.fill || 'none') + '"';
        if (st.fillOpacity != null && st.fillOpacity < 1) a += ' fill-opacity="' + n(st.fillOpacity) + '"';
      }
      if (st.stroke && (st.strokeWidth == null || st.strokeWidth > 0)) {
        a += ' stroke="' + st.stroke + '" stroke-width="' + n(st.strokeWidth == null ? 1 : st.strokeWidth) + '"';
        if (st.strokeOpacity != null && st.strokeOpacity < 1) a += ' stroke-opacity="' + n(st.strokeOpacity) + '"';
        if (st.dash && st.dash.length) a += ' stroke-dasharray="' + st.dash.join(' ') + '"';
        if (st.cap) a += ' stroke-linecap="' + st.cap + '"';
      }
      return a;
    }

    return {
      kind: 'svg',
      scale: 1,

      rect(x, y, w, h, st) {
        st = st || {};
        parts.push('<rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"' +
          (st.fill ? '' : ' fill="none"') + styleAttrs(st, !!st.fill) + '/>');
      },

      line(x1, y1, x2, y2, st) {
        if (!st || !st.stroke) return;
        parts.push('<line x1="' + n(x1) + '" y1="' + n(y1) + '" x2="' + n(x2) + '" y2="' + n(y2) + '"' +
          styleAttrs(st, false) + '/>');
      },

      polyline(pts, st) {
        if (!st || !st.stroke || pts.length < 2) return;
        parts.push('<polyline points="' + pts.map((p) => n(p[0]) + ',' + n(p[1])).join(' ') +
          '" fill="none"' + styleAttrs(st, false) + '/>');
      },

      markers(pts, st) {
        if (!pts.length) return;
        const shape = st.shape || 'circle';
        // One <g> carries the shared paint so the file stays small and every
        // series lands in Illustrator as a single selectable group.
        parts.push('<g' + styleAttrs(st, true) + (st.label ? ' data-series="' + esc(st.label) + '"' : '') + '>');
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (shape === 'circle') {
            parts.push('<circle cx="' + n(p.x) + '" cy="' + n(p.y) + '" r="' + n(p.r) + '"/>');
          } else {
            const path = markerPath(shape, p.x, p.y, p.r);
            let d = '';
            for (const seg of path) {
              d += seg[0] === 'Z' ? 'Z' : seg[0] + n(seg[1]) + ' ' + n(seg[2]) + ' ';
            }
            parts.push('<path d="' + d.trim() + '"/>');
          }
        }
        parts.push('</g>');
      },

      text(x, y, str, st) {
        st = st || {};
        const size = st.size || 12;
        const dy = baselineDy(st.baseline, size);
        const px = n(x), py = n(y + dy);
        let a = ' x="' + px + '" y="' + py + '"';
        a += ' font-family="' + esc(st.family || 'sans-serif') + '" font-size="' + n(size) + '"';
        if (st.weight && st.weight !== 'normal') a += ' font-weight="' + st.weight + '"';
        if (st.italic) a += ' font-style="italic"';
        if (st.anchor && st.anchor !== 'start') a += ' text-anchor="' + ANCHOR_SVG[st.anchor] + '"';
        if (st.rotate) a += ' transform="rotate(' + n(st.rotate) + ' ' + px + ' ' + py + ')"';
        if (st.opacity != null && st.opacity < 1) a += ' opacity="' + n(st.opacity) + '"';
        const body = esc(str);
        if (st.halo) {
          parts.push('<text' + a + ' fill="none" stroke="' + st.halo + '" stroke-width="' +
            n(st.haloWidth || 3) + '" stroke-linejoin="round">' + body + '</text>');
        }
        parts.push('<text' + a + ' fill="' + (st.fill || '#000') + '">' + body + '</text>');
      },

      clip(x, y, w, h) {
        const id = 'clip' + (++clipId);
        defs.push('<clipPath id="' + id + '"><rect x="' + n(x) + '" y="' + n(y) + '" width="' +
          n(w) + '" height="' + n(h) + '"/></clipPath>');
        parts.push('<g clip-path="url(#' + id + ')">');
      },
      unclip() { parts.push('</g>'); },

      group(label) { parts.push('<g' + (label ? ' data-layer="' + esc(label) + '"' : '') + '>'); },
      endGroup() { parts.push('</g>'); },

      toString() {
        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
          'width="' + n(width) + '" height="' + n(height) + '" ' +
          'viewBox="0 0 ' + n(width) + ' ' + n(height) + '">\n' +
          (defs.length ? '<defs>' + defs.join('') + '</defs>\n' : '') +
          parts.join('\n') + '\n</svg>\n';
      },
    };
  }

  /* --- text measurement --------------------------------------------------- */

  // Layout is measured once, on a shared canvas, so labels sit identically in
  // the PNG and the SVG.
  let measureCtx = null;
  function measureText(str, st) {
    if (!measureCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      measureCtx = c.getContext('2d');
    }
    measureCtx.font = fontString(st);
    return measureCtx.measureText(str).width;
  }

  VP.surface = { canvas: canvasSurface, svg: svgSurface, measureText, fontString, SHAPES, markerPath };
})(window.VP);
