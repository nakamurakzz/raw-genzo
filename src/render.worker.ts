// 現像 Worker。フル解像度のリニア画像とプレビュー用の縮小画像を保持し、
// レンズ補正 → LUT を当てた RGBA（プレビュー）や JPEG（書き出し）を返す。

import type { InputSpace, OutputSpace } from './color.ts';
import type { Lut3D } from './cube.ts';
import { HEADROOM_EV, autoScale, correctRows, lensActive, type LensParams } from './lens.ts';
import { downscale, medianLuma, renderRGBA } from './render.ts';

export type WorkerRequest =
  | { kind: 'load'; id: number; data: Uint16Array; width: number; height: number; previewMax: number }
  | { kind: 'lens'; id: number; params: LensParams | null }
  | { kind: 'lut'; id: number; key: string; lut: Lut3D }
  | { kind: 'preview'; id: number; key: string; input: InputSpace; output: OutputSpace; ev: number }
  | { kind: 'export'; id: number; key: string; input: InputSpace; output: OutputSpace; ev: number; quality: number };

export type WorkerResponse =
  | { id: number; ok: false; error: string }
  | { id: number; ok: true; kind: 'load'; pw: number; ph: number; median: number }
  | { id: number; ok: true; kind: 'lens'; ms: number; scale: number }
  | { id: number; ok: true; kind: 'lut' }
  | { id: number; ok: true; kind: 'preview'; rgba: Uint8ClampedArray; pw: number; ph: number; ms: number }
  | { id: number; ok: true; kind: 'export'; blob: Blob; ms: number };

interface Img { data: Uint16Array; width: number; height: number }

let full: Img | null = null;
let previewOrig: Img | null = null;
/** レンズ補正後のプレビュー（補正なしなら previewOrig と同じ） */
let preview: Img | null = null;
/** preview に足す露出（補正後のデータは 1/HEADROOM で持つため） */
let previewEV = 0;
let lens: LensParams | null = null;
const luts = new Map<string, Lut3D>();

function reply(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

function needLut(key: string): Lut3D {
  const l = luts.get(key);
  if (!l) throw new Error(`LUT が Worker に未登録です: ${key}`);
  return l;
}

function applyLensToPreview(): number {
  if (!previewOrig) return 1;
  if (!lensActive(lens)) {
    preview = previewOrig;
    previewEV = 0;
    return 1;
  }
  const { data, width: w, height: h } = previewOrig;
  const k = lens.distortion ? autoScale(lens.distortion, w, h) : 1;
  const out = new Uint16Array(w * h * 3);
  correctRows(data, w, h, lens, k, out, 0, h);
  preview = { data: out, width: w, height: h };
  previewEV = HEADROOM_EV;
  return k;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    switch (req.kind) {
      case 'load': {
        full = { data: req.data, width: req.width, height: req.height };
        previewOrig = downscale(req.data, req.width, req.height, req.previewMax);
        lens = null;
        applyLensToPreview();
        // 自動露出はカメラ JPEG と比べるので、補正前の画像で測る
        reply({ id: req.id, ok: true, kind: 'load', pw: previewOrig.width, ph: previewOrig.height, median: medianLuma(previewOrig.data) });
        break;
      }
      case 'lens': {
        const t0 = performance.now();
        lens = req.params;
        const scale = applyLensToPreview();
        reply({ id: req.id, ok: true, kind: 'lens', ms: performance.now() - t0, scale });
        break;
      }
      case 'lut': {
        luts.set(req.key, req.lut);
        reply({ id: req.id, ok: true, kind: 'lut' });
        break;
      }
      case 'preview': {
        if (!preview) throw new Error('画像が読み込まれていません');
        const t0 = performance.now();
        const rgba = new Uint8ClampedArray(preview.width * preview.height * 4);
        renderRGBA(preview.data, { lut: needLut(req.key), input: req.input, output: req.output, ev: req.ev + previewEV }, rgba);
        reply(
          { id: req.id, ok: true, kind: 'preview', rgba, pw: preview.width, ph: preview.height, ms: performance.now() - t0 },
          [rgba.buffer],
        );
        break;
      }
      case 'export': {
        if (!full) throw new Error('画像が読み込まれていません');
        const t0 = performance.now();
        const { width: w, height: h, data } = full;
        const corrected = lensActive(lens) ? lens : null;
        const k = corrected?.distortion ? autoScale(corrected.distortion, w, h) : 1;
        const params = {
          lut: needLut(req.key),
          input: req.input,
          output: req.output,
          ev: req.ev + (corrected ? HEADROOM_EV : 0),
        };
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('OffscreenCanvas の 2D コンテキストを作れませんでした');
        // メモリを抑えるため帯状に処理する
        const band = 256;
        const rgba = new Uint8ClampedArray(w * band * 4);
        const lin = corrected ? new Uint16Array(w * band * 3) : null;
        for (let y = 0; y < h; y += band) {
          const rows = Math.min(band, h - y);
          const view = rows === band ? rgba : rgba.subarray(0, w * rows * 4);
          if (lin && corrected) {
            correctRows(data, w, h, corrected, k, lin, y, rows);
            renderRGBA(lin, params, view, 0, w * rows);
          } else {
            renderRGBA(data, params, view, y * w, w * rows);
          }
          ctx.putImageData(new ImageData(view, w, rows), 0, y);
        }
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: req.quality });
        reply({ id: req.id, ok: true, kind: 'export', blob, ms: performance.now() - t0 });
        break;
      }
    }
  } catch (err) {
    reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
