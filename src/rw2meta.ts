// RW2（Panasonic）からレンズ補正に要るメタデータだけを読む小さなパーサ。
//   - IFD0 の 0x0119（DistortionInfo）: 歪曲補正の係数
//   - IFD0 の 0x002E（JpgFromRaw）の中の EXIF とメーカーノート:
//       LensType（0x0051）、ShadingCompensation（0x008A）、FNumber、FocalLength
// 入力は信頼できないファイルなので、すべての読み出しで範囲を確認し、壊れていたら null を返す。

export interface Distortion {
  /** Ru = Rd · (1 + a·Rd² + b·Rd⁴ + c·Rd⁶)。半径は画像の対角線の半分で正規化 */
  a: number;
  b: number;
  c: number;
}

export interface LensMeta {
  lensName: string | null;
  distortion: Distortion | null;
  /** カメラが RAW にシェーディング補正（周辺減光補正）をかけ済みか */
  shadingCompensation: boolean | null;
  focal: number | null;
  aperture: number | null;
}

const EMPTY: LensMeta = { lensName: null, distortion: null, shadingCompensation: null, focal: null, aperture: null };
const MAX_ENTRIES = 512;

class Reader {
  readonly v: DataView;
  readonly le: boolean;
  readonly base: number;
  constructor(v: DataView, base: number, le: boolean) {
    this.v = v;
    this.base = base;
    this.le = le;
  }
  ok(off: number, len: number) {
    return off >= 0 && len >= 0 && this.base + off + len <= this.v.byteLength;
  }
  u16(off: number) {
    if (!this.ok(off, 2)) throw new RangeError('u16');
    return this.v.getUint16(this.base + off, this.le);
  }
  i16(off: number) {
    if (!this.ok(off, 2)) throw new RangeError('i16');
    return this.v.getInt16(this.base + off, this.le);
  }
  u32(off: number) {
    if (!this.ok(off, 4)) throw new RangeError('u32');
    return this.v.getUint32(this.base + off, this.le);
  }
  bytes(off: number, len: number) {
    if (!this.ok(off, len)) throw new RangeError('bytes');
    return new Uint8Array(this.v.buffer, this.v.byteOffset + this.base + off, len);
  }
}

interface Entry { tag: number; type: number; count: number; valueOff: number }
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8 };

function readIfd(r: Reader, off: number): Map<number, Entry> {
  const out = new Map<number, Entry>();
  const n = r.u16(off);
  if (n > MAX_ENTRIES) throw new RangeError('too many entries');
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const count = r.u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueOff = size <= 4 ? e + 8 : r.u32(e + 8);
    if (!out.has(tag)) out.set(tag, { tag, type, count, valueOff });
  }
  return out;
}

function ascii(r: Reader, e: Entry | undefined): string | null {
  if (!e || e.count === 0 || e.count > 256) return null;
  const b = r.bytes(e.valueOff, e.count);
  let s = '';
  for (const c of b) {
    if (c === 0) break;
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
  }
  s = s.trim();
  return s || null;
}

function rational(r: Reader, e: Entry | undefined): number | null {
  if (!e || (e.type !== 5 && e.type !== 10) || e.count < 1) return null;
  const n = r.u32(e.valueOff);
  const d = r.u32(e.valueOff + 4);
  return d ? n / d : null;
}

function short(r: Reader, e: Entry | undefined): number | null {
  if (!e || e.count < 1) return null;
  if (e.type === 3 || e.type === 8) return r.u16(e.valueOff);
  if (e.type === 4 || e.type === 9) return r.u32(e.valueOff);
  if (e.type === 1 || e.type === 7) return r.bytes(e.valueOff, 1)[0];
  return null;
}

/** 0x0119 の 16 個の int16（リトルエンディアン）を係数にする（Rigo の解析 / darktable と同じ解釈） */
export function parseDistortionInfo(words: Int16Array): Distortion | null {
  if (words.length < 12) return null;
  if ((words[7] & 0x0f) !== 1) return null; // 補正フラグ
  const scale = 1 / (1 + words[5] / 32768);
  const a = (scale * words[8]) / 32768;
  const b = (scale * words[4]) / 32768;
  const c = (scale * words[11]) / 32768;
  if (![a, b, c].every(Number.isFinite)) return null;
  return { a, b, c };
}

/** 埋め込み JPEG の APP1（Exif）から TIFF ヘッダの位置を探す */
function findExifTiff(v: DataView, start: number, len: number): number | null {
  const end = Math.min(v.byteLength, start + len);
  if (start + 4 > end || v.getUint16(start) !== 0xffd8) return null;
  let p = start + 2;
  while (p + 4 <= end) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    if (marker === 0xda || marker === 0xd9) return null; // 画像データに入ったら終わり
    const segLen = v.getUint16(p + 2);
    if (segLen < 2 || p + 2 + segLen > end) return null;
    if (marker === 0xe1 && segLen >= 8 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
      return p + 10; // "Exif\0\0" の直後が TIFF ヘッダ
    }
    p += 2 + segLen;
  }
  return null;
}

function readExif(v: DataView, tiff: number, meta: LensMeta) {
  const bo = v.getUint16(tiff);
  if (bo !== 0x4949 && bo !== 0x4d4d) return;
  const r = new Reader(v, tiff, bo === 0x4949);
  if (r.u16(2) !== 42) return;
  const ifd0 = readIfd(r, r.u32(4));
  const exifPtr = ifd0.get(0x8769);
  if (!exifPtr) return;
  const exif = readIfd(r, r.u32(exifPtr.valueOff));
  meta.aperture ??= rational(r, exif.get(0x829d));
  meta.focal ??= rational(r, exif.get(0x920a));
  const lensModel = ascii(r, exif.get(0xa434));
  const mn = exif.get(0x927c);
  if (mn && mn.count > 14) {
    const sig = r.bytes(mn.valueOff, 9);
    if (String.fromCharCode(...sig) === 'Panasonic') {
      // "Panasonic\0\0\0" の後ろに IFD。オフセットは TIFF ヘッダ基準
      const pana = readIfd(r, mn.valueOff + 12);
      meta.lensName ??= ascii(r, pana.get(0x0051));
      const sc = short(r, pana.get(0x008a));
      if (sc !== null) meta.shadingCompensation = sc === 1;
    }
  }
  meta.lensName ??= lensModel;
}

export function readRw2LensMeta(bytes: Uint8Array): LensMeta {
  const meta: LensMeta = { ...EMPTY };
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.byteLength < 8 || v.getUint16(0) !== 0x4949) return meta;
    const magic = v.getUint16(2, true);
    if (magic !== 0x55) return meta; // RW2 以外（ほかのメーカーの RAW）は対象外
    const r = new Reader(v, 0, true);
    const ifd0 = readIfd(r, r.u32(4));

    const di = ifd0.get(0x0119);
    if (di && di.count === 32) {
      const b = r.bytes(di.valueOff, 32);
      const words = new Int16Array(16);
      const dv = new DataView(b.buffer, b.byteOffset, 32);
      for (let i = 0; i < 16; i++) words[i] = dv.getInt16(i * 2, true);
      meta.distortion = parseDistortionInfo(words);
    }

    const jpg = ifd0.get(0x002e);
    if (jpg && jpg.count > 0 && r.ok(jpg.valueOff, jpg.count)) {
      const tiff = findExifTiff(v, jpg.valueOff, jpg.count);
      if (tiff !== null) readExif(v, tiff, meta);
    }
  } catch {
    /* 壊れている部分は無視して、読めたところまでを返す */
  }
  return meta;
}
