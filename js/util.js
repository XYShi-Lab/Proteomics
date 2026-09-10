/* =============================================================================
   util.js - small helpers shared across the app. No dependencies.
   Everything hangs off the global VP namespace so the app also runs from a
   plain file:// URL (no module/CORS restrictions).
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  /* ---------- DOM ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    (Array.isArray(children) ? children : children != null ? [children] : []).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ---------- numbers ---------- */

  const SUP = { '-': '\u207b', '0': '\u2070', '1': '\u00b9', '2': '\u00b2', '3': '\u00b3',
    '4': '\u2074', '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079' };
  const superscript = (s) => String(s).replace(/[-0-9]/g, (c) => SUP[c] || c);

  // Format a p-value the way a journal would: a couple of significant digits,
  // and real superscript exponents (Unicode, so it survives copy-paste into a
  // manuscript and needs no markup).
  function fmtP(p) {
    if (p == null || !isFinite(p)) return '-';
    if (p === 0) return '0';
    if (p < 1e-3 || p >= 1e5) {
      const [m, e] = p.toExponential(1).split('e');
      return m + '\u00d710' + superscript(parseInt(e, 10));
    }
    const r = parseFloat(p.toPrecision(3));
    // Never round a non-significant p all the way up to a flat "1".
    return r >= 1 && p < 1 ? '0.999' : String(r);
  }

  function fmtNum(v, digits) {
    if (v == null || !isFinite(v)) return '-';
    const d = digits == null ? 3 : digits;
    if (v !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) return v.toExponential(2);
    const s = v.toFixed(d);
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  // Axis tick formatter - keeps tick labels short and consistent.
  function fmtTick(v, step) {
    if (Math.abs(v) < 1e-12) return '0';
    const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.abs(step))) + 0));
    if (Math.abs(v) >= 1e5) return v.toExponential(0);
    return v.toFixed(decimals);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* Standard 1-2-5 "nice" tick generator. */
  function niceTicks(min, max, target) {
    target = target || 6;
    if (!isFinite(min) || !isFinite(max) || min === max) {
      const c = isFinite(min) ? min : 0;
      return { ticks: [c], step: 1 };
    }
    const raw = (max - min) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    const ticks = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-6; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { ticks, step };
  }

  /* ---------- misc ---------- */

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms == null ? 150 : ms);
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }), filename);
  }

  /* CSV cell quoting for exports. */
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows) {
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  /* Colour helpers -------------------------------------------------------- */

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgba(hex, alpha) {
    const c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp(alpha == null ? 1 : alpha, 0, 1) + ')';
  }

  /* Stable ordering helper for tables. */
  function by(key, dir) {
    const s = dir === 'desc' ? -1 : 1;
    return (a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string' || typeof y === 'string') {
        return s * String(x).localeCompare(String(y));
      }
      return s * (x - y);
    };
  }

  VP.util = {
    $, $$, el, clear, fmtP, fmtNum, fmtTick, clamp, niceTicks, debounce,
    escapeHtml, downloadBlob, downloadText, csvCell, toCsv, hexToRgb, rgba,
    by, superscript,
  };
})(window.VP);
