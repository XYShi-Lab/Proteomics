/* =============================================================================
   xlsx.js - a minimal, dependency-free .xlsx reader.

   Proteomics results almost always arrive as an Excel workbook from the core
   facility, so the app reads .xlsx natively rather than making the user export
   a CSV first. We unzip with the browser's native DecompressionStream
   ('deflate-raw') and scan the sheet XML with a tolerant tokeniser - fast
   enough for the ~8k x 25 tables these files contain, and with no third-party
   code to vendor or trust.

   Not supported (deliberately): encrypted workbooks, ZIP64 archives, and
   date-formatted cells (returned as their raw Excel serial number). Proteomics
   result tables are text + numbers, so this covers them.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const td = new TextDecoder('utf-8');

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  /* --- ZIP ---------------------------------------------------------------- */

  function findEocd(dv, len) {
    // The end-of-central-directory record sits in the last 64k (comment field).
    const min = Math.max(0, len - 65557);
    for (let i = len - 22; i >= min; i--) {
      if (u32(dv, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function listEntries(buf) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    const eocd = findEocd(dv, len);
    if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end record found).');

    const count = u16(dv, eocd + 10);
    let ptr = u32(dv, eocd + 16);
    if (ptr === 0xffffffff || count === 0xffff) {
      throw new Error('ZIP64 workbooks are not supported. Please re-save the file or export as CSV/TSV.');
    }

    const entries = new Map();
    for (let i = 0; i < count && ptr + 46 <= len; i++) {
      if (u32(dv, ptr) !== 0x02014b50) break;
      const method = u16(dv, ptr + 10);
      const compSize = u32(dv, ptr + 20);
      const nameLen = u16(dv, ptr + 28);
      const extraLen = u16(dv, ptr + 30);
      const commentLen = u16(dv, ptr + 32);
      const localOff = u32(dv, ptr + 42);
      const name = td.decode(new Uint8Array(buf, ptr + 46, nameLen));
      entries.set(name, { method, compSize, localOff });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return { buf, dv, entries };
  }

  async function readEntry(zip, name) {
    const e = zip.entries.get(name);
    if (!e) return null;
    const dv = zip.dv;
    if (u32(dv, e.localOff) !== 0x04034b50) throw new Error('Corrupt entry: ' + name);
    const nameLen = u16(dv, e.localOff + 26);
    const extraLen = u16(dv, e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const bytes = new Uint8Array(zip.buf, start, e.compSize);

    if (e.method === 0) return td.decode(bytes);
    if (e.method !== 8) throw new Error('Unsupported ZIP compression in ' + name);
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'This browser cannot decompress .xlsx files. Please use a current ' +
        'Chrome, Edge, Firefox or Safari - or save your table as CSV/TSV.'
      );
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return td.decode(await new Response(stream).arrayBuffer());
  }

  /* --- XML ---------------------------------------------------------------- */

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeXml(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
      if (g[0] === '#') {
        const code = g[1] === 'x' || g[1] === 'X'
          ? parseInt(g.slice(2), 16)
          : parseInt(g.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENT[g] != null ? ENT[g] : m;
    });
  }

  // Collect the text of every <t> element inside a chunk of XML.
  const T_RE = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  function collectText(chunk) {
    let out = '', m;
    T_RE.lastIndex = 0;
    while ((m = T_RE.exec(chunk))) out += m[1] == null ? '' : m[1];
    return decodeXml(out);
  }

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    // Split on item boundaries rather than DOM-parsing: shared string tables in
    // proteomics workbooks routinely run to tens of thousands of entries.
    const parts = xml.split('</si>');
    for (let i = 0; i < parts.length; i++) {
      const idx = parts[i].indexOf('<si');
      if (idx < 0) continue;
      out.push(collectText(parts[i].slice(idx)));
    }
    return out;
  }

  /* Convert a cell reference such as "BC12" to a zero-based column index. */
  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  const ROW_RE = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  const CELL_RE = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const ATTR_RE = /(\w+)="([^"]*)"/g;
  const V_RE = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/;

  function parseSheet(xml, strings, maxRows) {
    const rows = [];
    let m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(xml))) {
      const inner = m[1];
      const cells = [];
      let width = 0;
      if (inner) {
        let cm;
        CELL_RE.lastIndex = 0;
        while ((cm = CELL_RE.exec(inner))) {
          const attrs = cm[1] || '';
          const body = cm[2] || '';
          let ref = null, type = null, am;
          ATTR_RE.lastIndex = 0;
          while ((am = ATTR_RE.exec(attrs))) {
            if (am[1] === 'r') ref = am[2];
            else if (am[1] === 't') type = am[2];
          }
          const ci = ref ? colIndex(ref) : cells.length;
          let value = null;
          if (type === 'inlineStr') {
            value = collectText(body);
          } else {
            const vm = V_RE.exec(body);
            if (vm) {
              const raw = decodeXml(vm[1]);
              if (type === 's') {
                const si = parseInt(raw, 10);
                value = strings[si] != null ? strings[si] : '';
              } else if (type === 'b') {
                value = raw === '1' ? 'TRUE' : 'FALSE';
              } else {
                value = raw;
              }
            }
          }
          if (ci >= 0) {
            cells[ci] = value;
            if (ci + 1 > width) width = ci + 1;
          }
        }
      }
      const row = new Array(width);
      for (let i = 0; i < width; i++) row[i] = cells[i] == null ? '' : cells[i];
      rows.push(row);
      if (maxRows && rows.length >= maxRows) break;
    }
    return rows;
  }

  /* --- public ------------------------------------------------------------- */

  /**
   * Read a workbook from an ArrayBuffer.
   * @returns {Promise<{sheets: Array<{name:string, rows:string[][]}>}>}
   */
  async function read(arrayBuffer) {
    const zip = listEntries(arrayBuffer);
    const strings = parseSharedStrings(await readEntry(zip, 'xl/sharedStrings.xml'));

    // Resolve sheet name -> part name through the workbook relationships so we
    // honour the author's sheet order instead of guessing sheet1.xml, sheet2...
    const wb = await readEntry(zip, 'xl/workbook.xml');
    const rels = await readEntry(zip, 'xl/_rels/workbook.xml.rels');
    const relMap = new Map();
    if (rels) {
      const re = /<Relationship\s[^>]*>/g;
      let m;
      while ((m = re.exec(rels))) {
        const tag = m[0];
        const id = /Id="([^"]+)"/.exec(tag);
        const target = /Target="([^"]+)"/.exec(tag);
        if (id && target) {
          let t = decodeXml(target[1]).replace(/^\/?xl\//, '').replace(/^\//, '');
          relMap.set(id[1], 'xl/' + t);
        }
      }
    }

    const sheets = [];
    if (wb) {
      const re = /<sheet\s[^>]*\/?>/g;
      let m;
      while ((m = re.exec(wb))) {
        const tag = m[0];
        const name = /name="([^"]*)"/.exec(tag);
        const rid = /r:id="([^"]+)"/.exec(tag) || /relationshipId="([^"]+)"/.exec(tag);
        const part = rid ? relMap.get(rid[1]) : null;
        sheets.push({
          name: name ? decodeXml(name[1]) : 'Sheet ' + (sheets.length + 1),
          part: part || 'xl/worksheets/sheet' + (sheets.length + 1) + '.xml',
        });
      }
    }
    if (!sheets.length) sheets.push({ name: 'Sheet1', part: 'xl/worksheets/sheet1.xml' });

    const out = [];
    for (const s of sheets) {
      let xml = await readEntry(zip, s.part);
      if (xml == null) xml = await readEntry(zip, s.part.replace('xl/', 'xl/worksheets/'));
      out.push({ name: s.name, rows: xml ? parseSheet(xml, strings) : [] });
    }
    return { sheets: out };
  }

  VP.xlsx = { read };
})(window.VP);
