// Minimal Parquet reader (no dependencies; used by backtest/hoopr_box.mjs): flat schemas, optional/required columns,
// PLAIN + RLE_DICTIONARY/PLAIN_DICTIONARY encodings, data pages v1/v2, ZSTD/SNAPPY-less
// (ZSTD via Node zlib, UNCOMPRESSED, GZIP). Enough for the hoopR box score files.
import fs from "node:fs";
import zlib from "node:zlib";

// ---- Thrift compact protocol ----
class TReader {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  byte() { return this.b[this.p++]; }
  varint() { let r = 0n, s = 0n, x; do { x = this.byte(); r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); return r; }
  zz() { const v = this.varint(); return Number((v >> 1n) ^ -(v & 1n)); }
  zz64() { const v = this.varint(); return (v >> 1n) ^ -(v & 1n); }
  bin() { const n = Number(this.varint()); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  readStruct() {
    const out = {}; let last = 0;
    for (;;) {
      const h = this.byte(); if (h === 0) return out;
      const t = h & 0x0f, d = h >> 4;
      const id = d ? last + d : this.zz();
      last = id; out[id] = this.readVal(t);
    }
  }
  readVal(t) {
    switch (t) {
      case 1: return true; case 2: return false;          // bool true/false (in struct)
      case 3: return this.byte() << 24 >> 24;               // i8
      case 4: case 5: return this.zz();                     // i16, i32
      case 6: return this.zz64();                           // i64
      case 7: { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
      case 8: return this.bin();                            // binary/string
      case 9: case 10: {                                    // list / set
        const h = this.byte(); let n = h >> 4; const et = h & 0x0f;
        if (n === 15) n = Number(this.varint());
        const a = []; for (let i = 0; i < n; i++) a.push(et === 1 || et === 2 ? this.byte() === 1 : this.readVal(et)); return a;
      }
      case 11: {                                            // map
        const n = Number(this.varint()); if (!n) return {};
        const kv = this.byte(); const m = [];
        for (let i = 0; i < n; i++) m.push([this.readVal(kv >> 4), this.readVal(kv & 0x0f)]); return m;
      }
      case 12: return this.readStruct();
      default: throw new Error("thrift type " + t);
    }
  }
}

function decompress(codec, buf, size) {
  if (codec === 0) return buf;
  if (codec === 6) return zlib.zstdDecompressSync(buf);
  if (codec === 2) return zlib.gunzipSync(buf);
  throw new Error("codec " + codec + " not supported");
}

// RLE / bit-packed hybrid
function readHybrid(buf, pos, end, bitWidth, count) {
  const out = []; const bw = bitWidth, byteW = Math.ceil(bw / 8);
  while (out.length < count && pos < end) {
    let h = 0, s = 0, x; do { x = buf[pos++]; h |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    if (h & 1) {                                             // bit-packed groups of 8
      const groups = h >>> 1, n = groups * 8; let bits = 0, acc = 0, i = 0;
      const bytes = groups * bw;
      for (let k = 0; k < bytes; k++) {
        acc |= buf[pos + k] << bits; bits += 8;
        while (bits >= bw && i < n) { out.push(acc & ((1 << bw) - 1)); acc >>>= bw; bits -= bw; i++; }
      }
      pos += bytes;
    } else {
      const n = h >>> 1; let v = 0;
      for (let k = 0; k < byteW; k++) v |= buf[pos + k] << (8 * k);
      pos += byteW; for (let i = 0; i < n; i++) out.push(v);
    }
  }
  return out.slice(0, count);
}

function plain(buf, pos, type, n) {
  const out = [];
  if (type === 0) { for (let i = 0; i < n; i++) { const b = pos * 8 + i; out.push(((buf[b >> 3] >> (b & 7)) & 1) === 1); } return out; }
  for (let i = 0; i < n; i++) {
    if (type === 1) { out.push(buf.readInt32LE(pos)); pos += 4; }
    else if (type === 2) { out.push(Number(buf.readBigInt64LE(pos))); pos += 8; }
    else if (type === 4) { out.push(buf.readFloatLE(pos)); pos += 4; }
    else if (type === 5) { out.push(buf.readDoubleLE(pos)); pos += 8; }
    else if (type === 6) { const l = buf.readInt32LE(pos); pos += 4; out.push(buf.toString("utf8", pos, pos + l)); pos += l; }
    else if (type === 0) { out.push(((buf[pos >> 3] >> (pos & 7)) & 1) === 1); pos++; }
    else throw new Error("type " + type);
  }
  return out;
}

export function readParquet(path, wanted) {
  const buf = fs.readFileSync(path);
  const metaLen = buf.readUInt32LE(buf.length - 8);
  const meta = new TReader(buf, buf.length - 8 - metaLen).readStruct();
  const schema = meta[2].slice(1).map((s) => ({ name: s[4].toString(), type: s[1], rep: s[3] }));
  const numRows = Number(meta[3]);
  const cols = {};
  const want = new Set(wanted || schema.map((s) => s.name));
  for (const rg of meta[4]) {
    for (const cc of rg[1]) {
      const md = cc[3]; const name = md[3].map((x) => x.toString()).join(".");
      if (!want.has(name)) continue;
      const sch = schema.find((s) => s.name === name); const type = md[1], codec = md[4];
      const optional = sch.rep === 1;
      let pos = Number(md[11] ?? md[9]); const end = Number(md[9]) + Number(md[7]);
      let dict = null; const vals = cols[name] || (cols[name] = []);
      const startDict = md[11] !== undefined ? Number(md[11]) : null;
      pos = startDict !== null && startDict < Number(md[9]) ? startDict : Number(md[9]);
      let remaining = Number(md[5]);
      while (remaining > 0 && pos < buf.length) {
        const tr = new TReader(buf, pos); const ph = tr.readStruct(); pos = tr.p;
        const ptype = ph[1], usize = ph[2], csize = ph[3];
        const raw = buf.subarray(pos, pos + csize); pos += csize;
        if (ptype === 2) {                                    // dictionary page
          const d = decompress(codec, raw, usize); dict = plain(d, 0, type, ph[7][1]); continue;
        }
        let n, defs = null, body, bpos = 0;
        if (ptype === 0) {                                    // data page v1
          const h = ph[5]; n = h[1]; body = decompress(codec, raw, usize);
          if (optional) { const l = body.readInt32LE(0); defs = readHybrid(body, 4, 4 + l, 1, n); bpos = 4 + l; }
          var enc = h[2];
        } else if (ptype === 3) {                             // data page v2
          const h = ph[8]; n = h[3] ?? h[1]; const dl = h[5], rl = h[6];
          const levels = raw.subarray(0, rl + dl);
          if (optional && dl) defs = readHybrid(levels, rl, rl + dl, 1, n);
          const isComp = h[7] !== false;
          body = isComp ? decompress(codec, raw.subarray(rl + dl), usize - rl - dl) : raw.subarray(rl + dl);
          var enc = h[4];
        } else continue;
        const present = defs ? defs.filter((x) => x === 1).length : n;
        let got;
        if (enc === 0) got = plain(body, bpos, type, present);
        else if (enc === 2 || enc === 8) { const bw = body[bpos]; got = readHybrid(body, bpos + 1, body.length, bw, present).map((i) => dict[i]); }
        else throw new Error(`encoding ${enc} in ${name}`);
        if (defs) { let k = 0; for (const d of defs) vals.push(d === 1 ? got[k++] : null); } else vals.push(...got);
        remaining -= n;
      }
    }
  }
  return { numRows, schema, cols };
}
