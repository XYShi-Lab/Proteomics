/* =============================================================================
   pngmeta.js - read and write a text chunk inside a PNG.

   Lets an exported figure carry the settings that produced it, so dropping the
   PNG back into the app restores the whole format - cutoffs, styling, labels,
   clusters. The payload rides in an uncompressed iTXt chunk, which is the PNG
   text chunk that is defined as UTF-8 (tEXt is Latin-1 only, and axis labels
   here contain characters like the subscript 2).

   Image viewers ignore unknown ancillary chunks, so the PNG stays a completely
   ordinary image everywhere else.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const KEYWORD = 'ShiLabVolcanoSettings';

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return false;
    return true;
  }

  const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  function writeU32(b, o, v) {
    b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff;
  }
  const typeAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  /** Walk the chunk list. Returns [{type, start, dataStart, dataLength, total}]. */
  function chunks(bytes) {
    const out = [];
    let p = 8;
    while (p + 8 <= bytes.length) {
      const len = readU32(bytes, p);
      const type = typeAt(bytes, p + 4);
      const total = 12 + len;
      out.push({ type, start: p, dataStart: p + 8, dataLength: len, total });
      if (type === 'IEND') break;
      p += total;
    }
    return out;
  }

  function buildITxt(keyword, text) {
    const kw = [];
    for (let i = 0; i < keyword.length; i++) kw.push(keyword.charCodeAt(i) & 0xff);
    const body = new TextEncoder().encode(text);
    // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
    const data = new Uint8Array(kw.length + 1 + 1 + 1 + 1 + 1 + body.length);
    let o = 0;
    for (const c of kw) data[o++] = c;
    data[o++] = 0;      // keyword terminator
    data[o++] = 0;      // compression flag: uncompressed
    data[o++] = 0;      // compression method
    data[o++] = 0;      // empty language tag
    data[o++] = 0;      // empty translated keyword
    data.set(body, o);

    const chunk = new Uint8Array(12 + data.length);
    writeU32(chunk, 0, data.length);
    const type = 'iTXt';
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    writeU32(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length));
    return chunk;
  }

  /**
   * Return a copy of the PNG with `text` stored under `keyword`, replacing any
   * chunk already carrying that keyword so a re-export never accumulates them.
   */
  function embed(buffer, text, keyword) {
    const bytes = new Uint8Array(buffer);
    if (!isPng(bytes)) throw new Error('Not a PNG.');
    const kw = keyword || KEYWORD;
    const list = chunks(bytes);

    const keep = list.filter((c) => !(c.type === 'iTXt' && chunkKeyword(bytes, c) === kw));
    const insert = buildITxt(kw, text);

    let size = 8 + insert.length;
    for (const c of keep) size += c.total;
    const out = new Uint8Array(size);
    out.set(bytes.subarray(0, 8), 0);
    let o = 8;
    for (const c of keep) {
      // Ancillary text must sit before IEND.
      if (c.type === 'IEND') { out.set(insert, o); o += insert.length; }
      out.set(bytes.subarray(c.start, c.start + c.total), o);
      o += c.total;
    }
    return out;
  }

  function chunkKeyword(bytes, c) {
    let end = c.dataStart;
    const limit = Math.min(c.dataStart + 80, c.dataStart + c.dataLength);
    while (end < limit && bytes[end] !== 0) end++;
    let s = '';
    for (let i = c.dataStart; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** Read back the text stored under `keyword`, or null. */
  function extract(buffer, keyword) {
    const bytes = new Uint8Array(buffer);
    if (!isPng(bytes)) return null;
    const kw = keyword || KEYWORD;
    for (const c of chunks(bytes)) {
      if (c.type !== 'iTXt' && c.type !== 'tEXt') continue;
      if (chunkKeyword(bytes, c) !== kw) continue;
      let p = c.dataStart + kw.length + 1;
      if (c.type === 'iTXt') {
        const compressed = bytes[p];
        p += 2;                                   // compression flag + method
        if (compressed) return null;              // deflate payloads not written by us
        while (p < c.dataStart + c.dataLength && bytes[p] !== 0) p++; p++;   // language tag
        while (p < c.dataStart + c.dataLength && bytes[p] !== 0) p++; p++;   // translated keyword
      }
      return new TextDecoder('utf-8').decode(bytes.subarray(p, c.dataStart + c.dataLength));
    }
    return null;
  }

  VP.pngmeta = { embed, extract, isPng, crc32, chunks, KEYWORD };
})(window.VP);
