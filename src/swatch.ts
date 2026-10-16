// LUT ごとの見本チャート。グレーの段階とカラーチェッカーの代表色（シーンリニア Rec.2020）を
// 同じ現像パイプラインに通して、一覧に小さな帯として描く。

import type { LutEntry } from './luts.ts';
import { renderRGBA } from './render.ts';

// 18% グレーを中心に ±2 段
const GRAYS = [-2, -1, 0, 1, 2].map((s) => 0.18 * 2 ** s);
// ColorChecker（2014年以降版）を Rec.2020 リニアへ変換した値
const PATCHES: number[][] = [
  [0.4517, 0.2962, 0.2224], // light skin
  [0.1372, 0.085, 0.0571], // dark skin
  [0.1418, 0.1846, 0.3129], // blue sky
  [0.1182, 0.1465, 0.0605], // foliage
  [0.2937, 0.0647, 0.0468], // red
  [0.5359, 0.2377, 0.0567], // orange
  [0.7175, 0.5863, 0.0685], // yellow
  [0.1277, 0.2724, 0.0815], // green
  [0.0657, 0.2161, 0.3576], // cyan
  [0.0411, 0.0484, 0.259], // blue
];

const CELLS = [...GRAYS.map((g) => [g, g, g]), ...PATCHES];
const SRC = new Uint16Array(CELLS.flatMap((c) => c.map((v) => Math.round(Math.min(1, v) * 65535))));

const cache = new Map<string, Uint8ClampedArray>();

export function swatchColors(e: LutEntry): Uint8ClampedArray {
  let rgba = cache.get(e.key + e.input + e.output);
  if (!rgba) {
    rgba = new Uint8ClampedArray(CELLS.length * 4);
    renderRGBA(SRC, { lut: e.lut, input: e.input, output: e.output, ev: 0 }, rgba);
    cache.set(e.key + e.input + e.output, rgba);
  }
  return rgba;
}

export const SWATCH_GRAY_COUNT = GRAYS.length;

export function drawSwatch(canvas: HTMLCanvasElement, e: LutEntry) {
  const rgba = swatchColors(e);
  const n = CELLS.length;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 160;
  const cssH = canvas.clientHeight || 12;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const gap = Math.round(2 * dpr);
  const total = canvas.width - gap; // グレーと色の間にだけ隙間
  for (let i = 0; i < n; i++) {
    const x0 = Math.round((i / n) * total) + (i >= SWATCH_GRAY_COUNT ? gap : 0);
    const x1 = Math.round(((i + 1) / n) * total) + (i >= SWATCH_GRAY_COUNT ? gap : 0);
    ctx.fillStyle = `rgb(${rgba[i * 4]} ${rgba[i * 4 + 1]} ${rgba[i * 4 + 2]})`;
    ctx.fillRect(x0, 0, x1 - x0, canvas.height);
  }
}
