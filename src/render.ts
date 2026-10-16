// 現像の中核。DOM に依存しない純粋関数なので Worker とテストの両方から使う。
//
//   リニア Rec.2020 (uint16)  ×露出
//     → [行列: LUT の入力原色へ]   ※F-Log2 / F-Log は F-Gamut = Rec.2020 なので省略
//     → エンコード (F-Log2 / F-Log / sRGB)
//     → 3D LUT（四面体補間）
//     → [Display P3 出力なら sRGB へ変換]
//     → RGBA8

import { INPUTS, P3_TO_SRGB, srgbDecode, srgbEncode, type InputSpace, type OutputSpace } from './color.ts';
import type { Lut3D } from './cube.ts';

export interface RenderParams {
  lut: Lut3D;
  input: InputSpace;
  output: OutputSpace;
  /** 露出（EV）。入力ごとの基準ずれ refEV はこの関数内で足す */
  ev: number;
}

const TABLE_SIZE = 65536;

/** 入力値（0..65535 のインデックス）→ LUT 格子座標 [0, size-1] のテーブルを作る */
function buildTables(p: RenderParams) {
  const spec = INPUTS[p.input];
  const gain = 2 ** (p.ev + spec.refEV);
  // 行列なし: インデックス = uint16 値そのもの。行列あり: リニア値を [0, hi] に写したもの。
  const hi = spec.matrix ? (spec.clip ? 1 : gain * 1.3) : gain;
  const n1 = p.lut.size - 1;
  const tables: Float32Array[] = [];
  const same =
    p.lut.domainMin[0] === p.lut.domainMin[1] && p.lut.domainMin[1] === p.lut.domainMin[2] &&
    p.lut.domainMax[0] === p.lut.domainMax[1] && p.lut.domainMax[1] === p.lut.domainMax[2];
  for (let c = 0; c < (same ? 1 : 3); c++) {
    const t = new Float32Array(TABLE_SIZE);
    const dmin = p.lut.domainMin[c];
    const scale = n1 / (p.lut.domainMax[c] - dmin);
    for (let i = 0; i < TABLE_SIZE; i++) {
      let x = (i / (TABLE_SIZE - 1)) * hi;
      if (spec.clip && x > 1) x = 1;
      let v = (spec.encode(x) - dmin) * scale;
      if (v < 0) v = 0;
      else if (v > n1) v = n1;
      t[i] = v;
    }
    tables.push(t);
  }
  while (tables.length < 3) tables.push(tables[0]);
  return { tables, gain, hi, matrix: spec.matrix };
}

let outTables: { dec: Float32Array; enc: Float32Array } | null = null;
const OUT_DEC = 4096;
const OUT_ENC = 16384;
function getOutTables() {
  if (!outTables) {
    const dec = new Float32Array(OUT_DEC + 1);
    for (let i = 0; i <= OUT_DEC; i++) dec[i] = srgbDecode(i / OUT_DEC);
    const enc = new Float32Array(OUT_ENC + 1);
    for (let i = 0; i <= OUT_ENC; i++) enc[i] = srgbEncode(i / OUT_ENC);
    outTables = { dec, enc };
  }
  return outTables;
}

/**
 * src: RGB インターリーブの uint16（リニア Rec.2020、センサー飽和 = 65535）
 * out: RGBA8。src の pixelStart から pixelCount 画素ぶんを out の先頭から書く。
 */
export function renderRGBA(
  src: Uint16Array,
  p: RenderParams,
  out: Uint8ClampedArray,
  pixelStart = 0,
  pixelCount = src.length / 3,
): void {
  const { tables, gain, hi, matrix } = buildTables(p);
  const [T0, T1, T2] = tables;
  const N = p.lut.size;
  const N2 = N * N;
  const L = p.lut.data;
  const nMax = N - 2;
  const toP3 = p.output === 'p3';
  const { dec, enc } = getOutTables();
  const m = matrix;
  const k = gain / 65535 / hi * (TABLE_SIZE - 1);

  let s = pixelStart * 3;
  let o = 0;
  for (let px = 0; px < pixelCount; px++, s += 3, o += 4) {
    let x: number, y: number, z: number;
    if (m === null) {
      x = T0[src[s]];
      y = T1[src[s + 1]];
      z = T2[src[s + 2]];
    } else {
      const r = src[s], g = src[s + 1], b = src[s + 2];
      let ir = (m[0] * r + m[1] * g + m[2] * b) * k;
      let ig = (m[3] * r + m[4] * g + m[5] * b) * k;
      let ib = (m[6] * r + m[7] * g + m[8] * b) * k;
      ir = ir < 0 ? 0 : ir > 65535 ? 65535 : ir + 0.5;
      ig = ig < 0 ? 0 : ig > 65535 ? 65535 : ig + 0.5;
      ib = ib < 0 ? 0 : ib > 65535 ? 65535 : ib + 0.5;
      x = T0[ir | 0];
      y = T1[ig | 0];
      z = T2[ib | 0];
    }

    // 四面体補間
    let i = x | 0, j = y | 0, l = z | 0;
    if (i > nMax) i = nMax;
    if (j > nMax) j = nMax;
    if (l > nMax) l = nMax;
    const fx = x - i, fy = y - j, fz = z - l;
    const b000 = (i + j * N + l * N2) * 3;
    const dx = 3, dy = N * 3, dz = N2 * 3;
    const b111 = b000 + dx + dy + dz;
    let w0: number, w1: number, w2: number, w3: number, b1: number, b2: number;
    if (fx >= fy) {
      if (fy >= fz) { w0 = 1 - fx; w1 = fx - fy; w2 = fy - fz; w3 = fz; b1 = b000 + dx; b2 = b000 + dx + dy; }
      else if (fx >= fz) { w0 = 1 - fx; w1 = fx - fz; w2 = fz - fy; w3 = fy; b1 = b000 + dx; b2 = b000 + dx + dz; }
      else { w0 = 1 - fz; w1 = fz - fx; w2 = fx - fy; w3 = fy; b1 = b000 + dz; b2 = b000 + dx + dz; }
    } else {
      if (fz >= fy) { w0 = 1 - fz; w1 = fz - fy; w2 = fy - fx; w3 = fx; b1 = b000 + dz; b2 = b000 + dy + dz; }
      else if (fz >= fx) { w0 = 1 - fy; w1 = fy - fz; w2 = fz - fx; w3 = fx; b1 = b000 + dy; b2 = b000 + dy + dz; }
      else { w0 = 1 - fy; w1 = fy - fx; w2 = fx - fz; w3 = fz; b1 = b000 + dy; b2 = b000 + dx + dy; }
    }
    let R = w0 * L[b000] + w1 * L[b1] + w2 * L[b2] + w3 * L[b111];
    let G = w0 * L[b000 + 1] + w1 * L[b1 + 1] + w2 * L[b2 + 1] + w3 * L[b111 + 1];
    let B = w0 * L[b000 + 2] + w1 * L[b1 + 2] + w2 * L[b2 + 2] + w3 * L[b111 + 2];

    if (toP3) {
      const lr = dec[(R < 0 ? 0 : R > 1 ? 1 : R) * OUT_DEC + 0.5 | 0];
      const lg = dec[(G < 0 ? 0 : G > 1 ? 1 : G) * OUT_DEC + 0.5 | 0];
      const lb = dec[(B < 0 ? 0 : B > 1 ? 1 : B) * OUT_DEC + 0.5 | 0];
      const sr = P3_TO_SRGB[0] * lr + P3_TO_SRGB[1] * lg + P3_TO_SRGB[2] * lb;
      const sg = P3_TO_SRGB[3] * lr + P3_TO_SRGB[4] * lg + P3_TO_SRGB[5] * lb;
      const sb = P3_TO_SRGB[6] * lr + P3_TO_SRGB[7] * lg + P3_TO_SRGB[8] * lb;
      R = enc[(sr < 0 ? 0 : sr > 1 ? 1 : sr) * OUT_ENC + 0.5 | 0];
      G = enc[(sg < 0 ? 0 : sg > 1 ? 1 : sg) * OUT_ENC + 0.5 | 0];
      B = enc[(sb < 0 ? 0 : sb > 1 ? 1 : sb) * OUT_ENC + 0.5 | 0];
    }
    out[o] = R * 255;
    out[o + 1] = G * 255;
    out[o + 2] = B * 255;
    out[o + 3] = 255;
  }
}

/** 整数倍のボックスフィルタで縮小（リニアのまま平均するので正しい縮小になる） */
export function downscale(src: Uint16Array, w: number, h: number, maxSide: number) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const pw = Math.floor(w / f), ph = Math.floor(h / f);
  const dst = new Uint16Array(pw * ph * 3);
  const area = f * f;
  const acc = new Float64Array(pw * 3);
  for (let py = 0; py < ph; py++) {
    acc.fill(0);
    for (let dy = 0; dy < f; dy++) {
      let s = ((py * f + dy) * w) * 3;
      for (let px = 0; px < pw; px++) {
        let r = 0, g = 0, b = 0;
        for (let dx = 0; dx < f; dx++, s += 3) { r += src[s]; g += src[s + 1]; b += src[s + 2]; }
        acc[px * 3] += r; acc[px * 3 + 1] += g; acc[px * 3 + 2] += b;
      }
    }
    const o = py * pw * 3;
    for (let i = 0; i < pw * 3; i++) dst[o + i] = acc[i] / area + 0.5;
  }
  return { data: dst, width: pw, height: ph };
}

/** リニア Rec.2020 uint16 の輝度の中央値（0..1）。間引いてソート */
export function medianLuma(src: Uint16Array, maxSamples = 200000): number {
  const n = src.length / 3;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const ys = new Float32Array(Math.ceil(n / step));
  let k = 0;
  for (let i = 0; i < n; i += step) {
    const s = i * 3;
    ys[k++] = (0.2627 * src[s] + 0.678 * src[s + 1] + 0.0593 * src[s + 2]) / 65535;
  }
  const v = ys.subarray(0, k).sort();
  return v[k >> 1];
}
