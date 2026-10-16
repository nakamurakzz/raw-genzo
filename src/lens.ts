// レンズ補正（リニアの uint16 RGB に対して、LUT より前に行う）
//   歪曲: RW2 内蔵の係数。出力の各画素について元画像のどこを読むかを求め、双三次補間で取り出す。
//   周辺減光: Lensfun の pa モデル。元画像側の位置の半径でゲインを掛ける。
// 周辺を明るくすると 65535 を超えうるので、補正後のデータは 1/HEADROOM に縮めて持ち、
// 描画時に露出を log2(HEADROOM) 段足して戻す。

import type { Distortion } from './rw2meta.ts';

export interface LensParams {
  distortion: Distortion | null;
  vignetting: { k: [number, number, number]; rScale: number } | null;
}

export const HEADROOM = 2;
export const HEADROOM_EV = Math.log2(HEADROOM);

export const lensActive = (p: LensParams | null): p is LensParams => !!p && (!!p.distortion || !!p.vignetting);

/** Ru = f(Rd) */
export function distortForward(d: Distortion, rd: number): number {
  const r2 = rd * rd;
  return rd * (1 + r2 * (d.a + r2 * (d.b + r2 * d.c)));
}

/** f の逆関数（ニュートン法）。Rd = g(Ru) */
export function distortInverse(d: Distortion, ru: number): number {
  let rd = ru;
  for (let i = 0; i < 20; i++) {
    const r2 = rd * rd;
    const f = rd * (1 + r2 * (d.a + r2 * (d.b + r2 * d.c))) - ru;
    const df = 1 + r2 * (3 * d.a + r2 * (5 * d.b + r2 * 7 * d.c));
    if (!(df > 1e-6)) break;
    const step = f / df;
    rd -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  return rd;
}

const LUT_N = 4096;
const LUT_MAX = 1.05;

/** 出力半径 ru → 比 rd/ru のテーブル */
function ratioTable(d: Distortion): Float64Array {
  const t = new Float64Array(LUT_N + 2);
  for (let i = 0; i <= LUT_N + 1; i++) {
    const ru = (i / LUT_N) * LUT_MAX;
    t[i] = ru > 0 ? distortInverse(d, ru) / ru : 1; // ru→0 の極限は 1
  }
  return t;
}

/**
 * 補正後の画像が元画像の外を読まないように、出力全体を縮める倍率 k（≤ 1）を求める。
 * 樽型の補正（Ru > Rd）なら外にははみ出さないので 1 になる。
 */
export function autoScale(d: Distortion, w: number, h: number): number {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const hd = Math.hypot(w, h) / 2;
  let k = 1;
  const N = 256;
  for (let i = 0; i <= N; i++) {
    for (const [x, y] of [[(i / N) * (w - 1), 0], [0, (i / N) * (h - 1)]]) {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy) / hd;
      if (r === 0) continue;
      const inside = (kk: number) => {
        const s = distortInverse(d, kk * r) / r; // 元画像での位置 = 中心 + (dx, dy)·s
        return Math.abs(dx * s) <= cx + 1e-6 && Math.abs(dy * s) <= cy + 1e-6;
      };
      if (inside(k)) continue;
      let lo = 0.5, hi = k;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (inside(mid)) lo = mid;
        else hi = mid;
      }
      k = lo;
    }
  }
  return k;
}

/**
 * 元画像 src（w×h、RGB uint16）から、補正後の y0 行目から rows 行ぶんを out に書く（1/HEADROOM 倍）。
 * k は autoScale の結果（同じ画像サイズなら使い回せる）。
 */
export function correctRows(
  src: Uint16Array,
  w: number,
  h: number,
  p: LensParams,
  k: number,
  out: Uint16Array,
  y0: number,
  rows: number,
): void {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const inv = 2 / Math.sqrt(w * w + h * h);
  const d = p.distortion;
  const table = d ? ratioTable(d) : null;
  const v = p.vignetting;
  const k1 = v ? v.k[0] : 0, k2 = v ? v.k[1] : 0, k3 = v ? v.k[2] : 0;
  const vs2 = v ? (v.rScale * inv) ** 2 : 0;
  const base = 1 / HEADROOM;
  const lutScale = (LUT_N / LUT_MAX) * k * inv;
  const stride = w * 3;
  let o = 0;

  for (let y = y0; y < y0 + rows; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++, o += 3) {
      const dx = x - cx;
      let sx = x, sy = y;
      if (table) {
        const f = Math.sqrt(dx * dx + dy2) * lutScale;
        const i = f | 0;
        const ratio = i >= LUT_N ? table[LUT_N] : table[i] + (table[i + 1] - table[i]) * (f - i);
        const s = k * ratio;
        sx = cx + dx * s;
        sy = cy + dy * s;
      }
      let gain = base;
      if (v) {
        const ex = sx - cx, ey = sy - cy;
        const r2 = (ex * ex + ey * ey) * vs2;
        gain /= 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
      }
      let r: number, g: number, b: number;
      if (!table) {
        const s0 = (y * w + x) * 3;
        r = src[s0]; g = src[s0 + 1]; b = src[s0 + 2];
      } else {
        const ix = Math.floor(sx), iy = Math.floor(sy);
        // Catmull-Rom の重み
        const tx = sx - ix, ty = sy - iy;
        const tx2 = tx * tx, tx3 = tx2 * tx, ty2 = ty * ty, ty3 = ty2 * ty;
        const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx, wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
        const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx, wx3 = 0.5 * tx3 - 0.5 * tx2;
        const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty, wy1 = 1.5 * ty3 - 2.5 * ty2 + 1;
        const wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty, wy3 = 0.5 * ty3 - 0.5 * ty2;
        if (ix >= 1 && iy >= 1 && ix + 2 < w && iy + 2 < h) {
          // 内側: 4×4 をそのまま読む
          let p0 = ((iy - 1) * w + ix - 1) * 3;
          r = 0; g = 0; b = 0;
          for (let j = 0; j < 4; j++, p0 += stride) {
            const wy = j === 0 ? wy0 : j === 1 ? wy1 : j === 2 ? wy2 : wy3;
            const rr = wx0 * src[p0] + wx1 * src[p0 + 3] + wx2 * src[p0 + 6] + wx3 * src[p0 + 9];
            const gg = wx0 * src[p0 + 1] + wx1 * src[p0 + 4] + wx2 * src[p0 + 7] + wx3 * src[p0 + 10];
            const bb = wx0 * src[p0 + 2] + wx1 * src[p0 + 5] + wx2 * src[p0 + 8] + wx3 * src[p0 + 11];
            r += wy * rr; g += wy * gg; b += wy * bb;
          }
        } else {
          // 端: 座標を画像内に寄せる
          const wxs = [wx0, wx1, wx2, wx3], wys = [wy0, wy1, wy2, wy3];
          r = 0; g = 0; b = 0;
          for (let j = 0; j < 4; j++) {
            const yy = Math.min(h - 1, Math.max(0, iy - 1 + j));
            let rr = 0, gg = 0, bb = 0;
            for (let i = 0; i < 4; i++) {
              const xx = Math.min(w - 1, Math.max(0, ix - 1 + i));
              const s0 = (yy * w + xx) * 3;
              rr += wxs[i] * src[s0]; gg += wxs[i] * src[s0 + 1]; bb += wxs[i] * src[s0 + 2];
            }
            r += wys[j] * rr; g += wys[j] * gg; b += wys[j] * bb;
          }
        }
      }
      r *= gain; g *= gain; b *= gain;
      out[o] = r <= 0 ? 0 : r >= 65535 ? 65535 : r + 0.5;
      out[o + 1] = g <= 0 ? 0 : g >= 65535 ? 65535 : g + 0.5;
      out[o + 2] = b <= 0 ? 0 : b >= 65535 ? 65535 : b + 0.5;
    }
  }
}
