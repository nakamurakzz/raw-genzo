// 色空間とトランスファ関数。RAW は LibRaw で「リニア Rec.2020（D65）」として受け取る前提。
// F-Gamut は Rec.2020 と同じ原色なので、F-Log2 / F-Log 経路では行列変換が要らない。

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
type XY = readonly [number, number];
type Primaries = readonly [XY, XY, XY];

const D65: XY = [0.3127, 0.329];

export const PRIMARIES = {
  rec2020: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
  srgb: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
  p3: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
  // F-Gamut C（FUJIFILM, F-Log2 C 用）
  fGamutC: [[0.7347, 0.2653], [0.0263, 0.9737], [0.1173, -0.0224]],
} as const satisfies Record<string, Primaries>;

function xyToXYZ([x, y]: XY): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return r as unknown as Mat3;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

export function rgbToXyz(p: Primaries, w: XY = D65): Mat3 {
  const [r, g, b] = p.map(xyToXYZ);
  const P: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const W = xyToXYZ(w);
  const Pi = inv3(P);
  const S = [0, 1, 2].map((k) => Pi[k * 3] * W[0] + Pi[k * 3 + 1] * W[1] + Pi[k * 3 + 2] * W[2]);
  return [
    P[0] * S[0], P[1] * S[1], P[2] * S[2],
    P[3] * S[0], P[4] * S[1], P[5] * S[2],
    P[6] * S[0], P[7] * S[1], P[8] * S[2],
  ];
}

/** src 原色の RGB → dst 原色の RGB（白色点は両方 D65 なので順応なし） */
export function rgbToRgb(src: Primaries, dst: Primaries): Mat3 {
  return mul3(inv3(rgbToXyz(dst)), rgbToXyz(src));
}

export const REC2020_TO_SRGB = rgbToRgb(PRIMARIES.rec2020, PRIMARIES.srgb);
export const REC2020_TO_P3 = rgbToRgb(PRIMARIES.rec2020, PRIMARIES.p3);
export const REC2020_TO_FGAMUTC = rgbToRgb(PRIMARIES.rec2020, PRIMARIES.fGamutC);
export const P3_TO_SRGB = rgbToRgb(PRIMARIES.p3, PRIMARIES.srgb);
export const FGAMUTC_TO_SRGB = rgbToRgb(PRIMARIES.fGamutC, PRIMARIES.srgb);

// ---- F-Log / F-Log2（FUJIFILM データシートの定数） ----
export interface LogCurve { a: number; b: number; c: number; d: number; e: number; f: number; cut1: number; cut2: number }

export const FLOG2: LogCurve = {
  a: 5.555556, b: 0.064829, c: 0.245281, d: 0.384316, e: 8.799461, f: 0.092864,
  cut1: 0.000889, cut2: 0.100686685370811,
};
export const FLOG: LogCurve = {
  a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864,
  cut1: 0.00089, cut2: 0.100537775223865,
};

/** シーンリニア（反射率 18% グレー = 0.18）→ 正規化コード値（10bit フルレンジ / 1023） */
export function logEncode(x: number, k: LogCurve): number {
  return x >= k.cut1 ? k.c * Math.log10(k.a * x + k.b) + k.d : k.e * x + k.f;
}
export function logDecode(y: number, k: LogCurve): number {
  return y >= k.cut2 ? (10 ** ((y - k.d) / k.c) - k.b) / k.a : (y - k.f) / k.e;
}

// ---- sRGB ----
export function srgbEncode(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}
export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// ---- LUT の入力・出力の解釈 ----
export type InputSpace = 'flog2' | 'flog2c' | 'flog' | 'srgb' | 'p3' | 'scene';
export type OutputSpace = 'srgb' | 'p3';

export interface InputSpec {
  label: string;
  /** リニア Rec.2020 から LUT 入力原色への行列。null なら変換なし */
  matrix: Mat3 | null;
  encode: (x: number) => number;
  /** 0..1 に切ってからエンコードするか（sRGB 系） */
  clip: boolean;
  /**
   * 基準露出のずれ（EV）。シーンの 18% グレーを LUT が想定する位置に置くための補正。
   * F-Log 系は仕様上 0.18 がそのまま 18% グレー。
   * abpy の「リニアコントラスト」LUT は 0.098 付近を中間グレーとして作られている（実測 −0.88EV）。
   */
  refEV: number;
}

export const INPUTS: Record<InputSpace, InputSpec> = {
  flog2: { label: 'F-Log2（F-Gamut）', matrix: null, encode: (x) => logEncode(x, FLOG2), clip: false, refEV: 0 },
  flog2c: { label: 'F-Log2 C（F-Gamut C）', matrix: REC2020_TO_FGAMUTC, encode: (x) => logEncode(x, FLOG2), clip: false, refEV: 0 },
  flog: { label: 'F-Log（F-Gamut）', matrix: null, encode: (x) => logEncode(x, FLOG), clip: false, refEV: 0 },
  srgb: { label: 'sRGB（リニアコントラスト）', matrix: REC2020_TO_SRGB, encode: srgbEncode, clip: true, refEV: -0.88 },
  p3: { label: 'Display P3（リニアコントラスト）', matrix: REC2020_TO_P3, encode: srgbEncode, clip: true, refEV: -0.88 },
  // 内部用：シーンリニアを sRGB で符号化しただけのもの。恒等 LUT と組み合わせて「ニュートラル」を厳密に作る
  scene: { label: 'sRGB（シーンリニア）', matrix: REC2020_TO_SRGB, encode: srgbEncode, clip: true, refEV: 0 },
};

export const OUTPUT_LABEL: Record<OutputSpace, string> = {
  srgb: 'Rec.709 / sRGB',
  p3: 'Display P3',
};

/** Rec.2020 の輝度係数 */
export function lumaRec2020(r: number, g: number, b: number): number {
  return 0.2627 * r + 0.678 * g + 0.0593 * b;
}
/** Rec.709 / sRGB の輝度係数（リニア値に対して） */
export function lumaRec709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
