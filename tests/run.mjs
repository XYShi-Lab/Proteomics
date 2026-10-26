#!/usr/bin/env node
/* =============================================================================
   Smoke suite for Shi Lab Volcano & GO.

     node tests/run.mjs            run headless
     node tests/run.mjs --headed   watch it

   Starts its own static server on a free port, blocks every outbound host so
   the offline/degraded paths are exercised too, and stubs the one external
   endpoint needed to drive enrichment end to end.

   Needs Playwright with Chromium. Exits non-zero on any failure.
   ========================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');

/* --- Playwright, wherever it lives ------------------------------------- */
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* try next */ }
}
if (!chromium) {
  console.error('Playwright not found.  npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

/* --- static server ------------------------------------------------------ */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* --- tiny harness ------------------------------------------------------- */
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const group = (t) => console.log('\n' + t);

/* A gene-set library shaped like the real GMT, with the nesting that makes
   enrichment output redundant - which is what the network view exists for. */
const MITO = 'TOMM20 TOMM22 TOMM40 TIMM23 IMMT SDHA SDHB NDUFS1 NDUFV1 UQCRC1 UQCRC2 COX4I1 COX5A ATP5F1A ATP5F1B VDAC1 VDAC2 VDAC3 HSPD1 HSPA9 CS ACO2 IDH2 MDH2 HADHA HADHB ETFA ETFB PDHA1 DLD SOD2 CYCS OPA1 MFN1 MFN2'.split(' ');
const RIBO = 'RPL3 RPL4 RPL5 RPL6 RPL7 RPL8 RPL9 RPL10 RPL11 RPL13 RPL15 RPL23 RPL30 RPLP0 RPS2 RPS3 RPS4X RPS5 RPS6 RPS8'.split(' ');
const GMT = [
  ['mitochondrion (GO:0005739)', '', ...MITO],
  ['mitochondrial matrix (GO:0005759)', '', ...MITO.slice(0, 18)],
  ['mitochondrial inner membrane (GO:0005743)', '', ...MITO.slice(10, 30)],
  ['cytosolic ribosome (GO:0022626)', '', ...RIBO],
  ['nucleolus (GO:0005730)', '', 'NPM1', 'NCL', 'FBL', 'NOP56', 'NOP58', 'DDX21', 'XRN2', 'UBTF'],
].map((a) => a.join('\t')).join('\n');

const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
const page = await (await browser.newContext({
  viewport: { width: 1680, height: 1050 },
  acceptDownloads: true,
})).newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_|fonts\./.test(m.text())) consoleErrors.push('console: ' + m.text());
});

// Everything outbound is blocked; the two Enrichr endpoints are stubbed so the
// real download -> parse -> enrich -> table -> network path still runs.
await page.route('**://**', (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  if (url.includes('/Enrichr/datasetStatistics')) {
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ statistics: [{ libraryName: 'GO_Cellular_Component_2023', numTerms: 5 }] }) });
  }
  if (url.includes('/Enrichr/geneSetLibrary')) {
    return route.fulfill({ status: 200, contentType: 'text/plain', body: GMT });
  }
  return route.abort();
});

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(400);

/* ======================================================================== */
group('pure functions');

const stats = await page.evaluate(() => {
  const S = window.VP.stats;
  return {
    // exact values from integer arithmetic: sum C(K,i)C(N-K,n-i)/C(N,n)
    h1: S.hypergeomTail(3, 10, 20, 100),
    h2: S.hypergeomTail(12, 50, 300, 20000),
    bh: S.benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205]),
  };
});
ok('hypergeometric matches exact arithmetic (k=3,n=10,K=20,N=100)', near(stats.h1, 0.3187799362, 1e-9), String(stats.h1));
ok('hypergeometric far tail (k=12,n=50,K=300,N=20000)', near(stats.h2, 7.605595523e-12, 1e-20), String(stats.h2));
ok('Benjamini-Hochberg', near(stats.bh[0], 0.008, 1e-9) && near(stats.bh[6], 0.08457142857, 1e-9));

const fc = await page.evaluate(() => {
  const D = window.VP.data;
  const signed = { numeric: 100, negatives: 30, absBelowOne: 0, min: -56, max: 97 };
  const linear = { numeric: 100, negatives: 0, absBelowOne: 40, min: 0.02, max: 50 };
  const log2 = { numeric: 100, negatives: 40, absBelowOne: 60, min: -6, max: 6 };
  return {
    signed: D.detectFcScale('X_FC', signed),
    linear: D.detectFcScale('ratio', linear),
    log2: D.detectFcScale('X_FC', log2),
    byName: D.detectFcScale('log2FoldChange', signed),
    conv: [D.applyFcScale(-56.26, 'signed'), D.applyFcScale(8, 'linear'), D.applyFcScale(2.5, 'log2')],
  };
});
ok('detects signed fold change (gap around zero)', fc.signed === 'signed', fc.signed);
ok('detects a linear ratio', fc.linear === 'linear', fc.linear);
ok('detects log2 by distribution', fc.log2 === 'log2', fc.log2);
ok('a log2 header always wins', fc.byName === 'log2', fc.byName);
ok('signed -56.26 -> -5.814', near(fc.conv[0], -Math.log2(56.26), 1e-9));
ok('linear 8 -> 3', near(fc.conv[1], 3, 1e-12));
ok('log2 passes through', near(fc.conv[2], 2.5, 1e-12));

/* ======================================================================== */
group('load and classify');

await page.click('#btnDemo');
await page.waitForTimeout(500);
const loaded = await page.evaluate(() => ({
  n: VP.state.records.length,
  counts: VP.state.counts,
  geom: !!VP.state.geom,
  indexed: VP.state.index ? VP.state.index.pts.length : 0,
}));
ok('example dataset loads', loaded.n === 580, 'records=' + loaded.n);
ok('classified into up/down/ns', loaded.counts.up > 0 && loaded.counts.down > 0);
ok('geometry + hit index built', loaded.geom && loaded.indexed === loaded.n);

const painted = await page.evaluate(() => {
  const c = document.querySelector('#plot');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
  return n;
});
ok('canvas actually painted', painted > 50, 'non-white samples=' + painted);

/* ======================================================================== */
group('cutoffs');

await page.click('.rail-btn[data-panel="thresholds"]');
await page.fill('#inpFc', '4');
await page.dispatchEvent('#inpFc', 'change');
await page.waitForTimeout(300);
ok('UI takes a fold change, state keeps log2', near(await page.evaluate(() => VP.state.thresholds.fcCutoff), 2, 1e-9));
const tightened = await page.evaluate(() => VP.state.counts.up);
await page.fill('#inpFc', '2');
await page.dispatchEvent('#inpFc', 'change');
await page.waitForTimeout(300);
ok('a stricter cutoff calls fewer proteins', tightened < (await page.evaluate(() => VP.state.counts.up)));

/* ======================================================================== */
group('protein list matching');

await page.click('.rail-btn[data-panel="proteins"]');
await page.fill('#proteinList', 'TOMM22\nMICOS10, RPL3; RPS6 NOTAREALGENE');
await page.click('#btnApplyList');
await page.waitForTimeout(400);
const report = (await page.textContent('#matchReport')).replace(/\s+/g, ' ');
ok('matches across separators', /4 of 5/.test(report), report);
ok('reports the misses', /NOTAREALGENE/.test(report));

/* ======================================================================== */
group('clusters');

await page.click('.rail-btn[data-panel="clusters"]');
await page.evaluate(() => document.querySelector('.panel[data-panel="clusters"] .fold summary').click());
for (const n of ['Mitochondrion', 'Ribosome']) {
  await page.fill('#inpCustomName', n);
  await page.fill('#inpCustomGenes', await page.evaluate((k) => VP.demo.SETS[k].join(' '), n));
  await page.click('#btnAddCustomCluster');
  await page.waitForTimeout(200);
}
const cl = await page.evaluate(() => VP.state.clusters.map((c) => ({ n: c.name, m: c.matched, up: c.up, down: c.down })));
ok('two clusters matched', cl.length === 2 && cl[0].m === 144 && cl[1].m === 65, JSON.stringify(cl));
ok('per-cluster up/down counted', cl[0].up > cl[0].down && cl[1].down > cl[1].up);

await page.locator('.cl-mute').first().click();
await page.waitForTimeout(350);
const muted = await page.evaluate(() => {
  const r = VP.state.records.find((x) => x.muted);
  const s = r && VP.plot.styleFor(r, VP.state);
  return { any: !!r, colour: s && s.color, ns: VP.state.config.colors.ns,
           legend: VP.plot.visibleClusters(VP.state).map((c) => c.name) };
});
ok('greying a cluster draws it as background dots', muted.any && muted.colour === muted.ns);
ok('a greyed cluster leaves the legend', !muted.legend.includes('Mitochondrion'));
await page.locator('.cl-mute').first().click();
await page.waitForTimeout(350);

/* ======================================================================== */
group('figure geometry');

await page.click('.rail-btn[data-panel="style"]');
for (const pos of ['right', 'left', 'top', 'bottom']) {
  await page.selectOption('#selClPos', pos).catch(() => {});
  await page.click('.rail-btn[data-panel="clusters"]');
  await page.selectOption('#selClPos', pos);
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const g = VP.plot.computeGeometry(VP.state), L = VP.plot.clusterLegendLayout(VP.state, g);
    const plot = { x0: g.plotX, y0: g.plotY, x1: g.plotX + g.plotW, y1: g.plotY + g.plotH };
    const box = { x0: L.bx, y0: L.by, x1: L.bx + L.boxW, y1: L.by + L.boxH };
    return {
      overlap: !(box.x1 <= plot.x0 || plot.x1 <= box.x0 || box.y1 <= plot.y0 || plot.y1 <= box.y0),
      inside: box.x0 >= 0 && box.y0 >= 0 && box.x1 <= VP.state.config.width && box.y1 <= VP.state.config.height,
    };
  });
  ok('cluster legend "' + pos + '": never overlaps the plot', !r.overlap);
  ok('cluster legend "' + pos + '": stays inside the figure', r.inside);
}

await page.click('.rail-btn[data-panel="proteins"]');
await page.evaluate(() => {
  const r = document.querySelector('#rngAutoLabel');
  r.value = '25'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(500);
const labels = await page.evaluate(() => {
  const g = VP.plot.computeGeometry(VP.state), laid = VP.plot.layoutLabels(VP.state, g);
  const boxes = [VP.plot.legendLayout(VP.state, g), VP.plot.clusterLegendLayout(VP.state, g)]
    .filter((L) => L && L.overlapsPlot)
    .map((L) => ({ x0: L.bx, y0: L.by, x1: L.bx + L.boxW, y1: L.by + L.boxH }));
  let outside = 0, onLegend = 0;
  for (const L of laid.labels) {
    const w = VP.surface.measureText(L.text, laid.font);
    const x0 = L.anchor === 'start' ? L.x : L.anchor === 'end' ? L.x - w : L.x - w / 2;
    const b = { x0, x1: x0 + w, y0: L.y - laid.font.size * 0.8, y1: L.y + laid.font.size * 0.25 };
    if (b.x0 < g.plotX - 0.5 || b.x1 > g.plotX + g.plotW + 0.5 ||
        b.y0 < g.plotY - 0.5 || b.y1 > g.plotY + g.plotH + 0.5) outside++;
    for (const q of boxes) {
      if (!(b.x1 < q.x0 || q.x1 < b.x0 || b.y1 < q.y0 || q.y1 < b.y0)) onLegend++;
    }
  }
  return { n: laid.labels.length, outside, onLegend };
});
ok('every label stays inside the axes', labels.outside === 0, JSON.stringify(labels));
ok('no label is buried under a legend', labels.onLegend === 0, JSON.stringify(labels));

await page.click('.rail-btn[data-panel="style"]');
await page.click('#btnSquareGrid');
await page.waitForTimeout(350);
for (const [w, h] of [[500, 900], [1400, 400], [900, 900]]) {
  await page.fill('#inpWidth', String(w));
  await page.fill('#inpHeight', String(h));
  await page.waitForTimeout(350);
  const cell = await page.evaluate(() => {
    const g = VP.plot.computeGeometry(VP.state);
    return { w: g.plotW * g.xT.step / (g.dom.x1 - g.dom.x0), h: g.plotH * g.yT.step / (g.dom.y1 - g.dom.y0) };
  });
  ok('square grid holds at ' + w + '×' + h, near(cell.w, cell.h, 0.02), cell.w + ' vs ' + cell.h);
}
await page.click('#btnSquareGrid');
await page.fill('#inpWidth', '820');
await page.fill('#inpHeight', '620');
await page.waitForTimeout(350);

/* ======================================================================== */
group('export');

const svg = await page.evaluate(() => {
  const c = VP.state.config;
  const s = VP.surface.svg(c.width, c.height);
  VP.plot.draw(s, VP.state);
  const txt = s.toString();
  const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
  return {
    valid: !doc.querySelector('parsererror'),
    layers: [...doc.querySelectorAll('[data-layer]')].map((g) => g.getAttribute('data-layer')),
    series: [...doc.querySelectorAll('[data-series]')].map((g) => g.getAttribute('data-series')),
    marks: doc.querySelectorAll('circle,path').length,
  };
});
ok('SVG is well-formed XML', svg.valid);
ok('SVG carries named layers', svg.layers.includes('points') && svg.layers.includes('labels') && svg.layers.includes('axes'));
ok('each series is its own group', svg.series.length >= 3, JSON.stringify(svg.series));
ok('marks are vector', svg.marks > 100, 'marks=' + svg.marks);

// Invariant: the export entry points clear transient hover chrome. Exercise the
// real button, not plot.draw(), because clearing is the export's job.
await page.click('.rail-btn[data-panel="export"]');
await page.evaluate(() => { VP.state.legendHover = true; VP.state.clusterLegendHover = true; });
const [svgDl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#btnSvg')]);
const svgText = fs.readFileSync(await svgDl.path(), 'utf8');
ok('hover chrome never reaches an export', !/stroke-dasharray="4 3"/.test(svgText));
ok('export cleared the hover flags', (await page.evaluate(() => VP.state.legendHover === false && VP.state.clusterLegendHover === false)));

const png = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  const cfg = VP.state.config;
  c.width = cfg.width; c.height = cfg.height;
  VP.plot.draw(VP.surface.canvas(c.getContext('2d'), 1), VP.state);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const buf = await blob.arrayBuffer();
  const settings = JSON.stringify({ probe: 42, size: VP.state.config.point.size });
  const stamped = VP.pngmeta.embed(buf, settings);
  return { isPng: VP.pngmeta.isPng(stamped), back: VP.pngmeta.extract(stamped.buffer), grew: stamped.length > buf.byteLength };
});
ok('PNG stays a valid PNG after stamping', png.isPng && png.grew);
ok('settings round-trip out of the PNG', JSON.parse(png.back).probe === 42, png.back);

/* ======================================================================== */
group('enrichment and network');

await page.click('.rail-btn[data-panel="clusters"]');
await page.click('#btnLoadLib');
await page.waitForFunction(() => /terms loaded/.test(document.querySelector('#libStatus').textContent), null, { timeout: 20000 });
await page.click('.rail-btn[data-panel="pathways"]');
await page.selectOption('#selProvider', 'builtin');
await page.selectOption('#selEnrichSet', 'both');
await page.click('#btnRunEnrich');
await page.waitForFunction(() => VP.state.enrich.results.length > 0, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const enr = await page.evaluate(() => ({
  n: VP.state.enrich.results.length,
  top: VP.state.enrich.results[0].name,
  rows: document.querySelectorAll('#enrichBody tr').length,
  nodes: VP.state.net.graph ? VP.state.net.graph.nodes.length : 0,
  edges: VP.state.net.graph ? VP.state.net.graph.edges.length : 0,
  colours: VP.state.net.colorMap.size,
}));
ok('built-in engine returns terms with no enrichment server', enr.n > 0, JSON.stringify(enr));
ok('top hit is mitochondrial (the example simulates that)', /mitochondri/i.test(enr.top), enr.top);
ok('results table populated', enr.rows === enr.n);
ok('network built from the same results', enr.nodes > 0);
ok('nested terms produce edges', enr.edges > 0, 'edges=' + enr.edges);
ok('one colour per top term', enr.colours > 0);

const before = await page.evaluate(() => VP.state.clusters.length);
await page.locator('#enrichBody tr').first().locator('.mini').nth(0).click();
await page.waitForTimeout(500);
const afterColour = await page.evaluate(() => ({
  n: VP.state.clusters.length,
  matchesNetwork: (() => {
    const r = VP.state.enrich.results[0];
    const c = VP.state.clusters.find((x) => x.termId === r.id);
    const m = VP.state.net.colorMap.get(r.id);
    return !!c && !!m && c.color === m.color;
  })(),
}));
ok('colouring a term adds a cluster', afterColour.n === before + 1);
ok('table, network and plot share one colour', afterColour.matchesNetwork);

const pinnedBefore = await page.evaluate(() => VP.state.pinned.size);
await page.locator('#enrichBody tr').first().locator('.mini').nth(1).click();
await page.waitForTimeout(500);
ok('labelling a term pins its proteins', (await page.evaluate(() => VP.state.pinned.size)) > pinnedBefore);
await page.click('.rail-btn[data-panel="proteins"]');
await page.click('#btnUndoLabels');
await page.waitForTimeout(400);
ok('term labelling is undoable', (await page.evaluate(() => VP.state.pinned.size)) === pinnedBefore);

/* ======================================================================== */
group('degraded paths');

const offline = await page.evaluate(async () => {
  try {
    await VP.api.fetchAnnotations(['P12345']);
    return { threw: false };
  } catch (e) {
    return { threw: true, kind: e.kind, msg: e.message };
  }
});
ok('a blocked service throws a typed ApiError', offline.threw && offline.kind === 'network', JSON.stringify(offline));
ok('with a human-readable message', /could not reach/i.test(offline.msg || ''), offline.msg);

/* ======================================================================== */
ok('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join('\n      '));

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
