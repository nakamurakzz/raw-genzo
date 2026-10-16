// LibRaw（WebAssembly）で RAW を展開する。
// 出力はリニア（ガンマ 1.0）・16bit・Rec.2020・カメラのホワイトバランス。
// 自動明るさ補正は切るので、センサー飽和（緑）が 65535 になる。

import type LibRawClass from '../vendor/libraw/index.js';
import type { LibRawSettings } from '../vendor/libraw/index.js';
import { readRw2LensMeta, type LensMeta } from './rw2meta.ts';

export interface DecodedRaw {
  data: Uint16Array;
  width: number;
  height: number;
  flip: number;
  camera: string;
  exposure: string[];
  thumb: Blob | null;
  /** レンズ補正用のメタデータ（RW2 のみ。焦点距離と F 値は LibRaw の値で補う） */
  lens: LensMeta;
  ms: number;
}

const SETTINGS: LibRawSettings = {
  outputColor: 8, // Rec.2020（= F-Gamut の原色）
  outputBps: 16,
  gamm: [1, 1, 0, 0, 0, 0] as unknown as [number, number], // 型定義は2要素だが、ラッパーは6要素でないと無視する
  noAutoBright: true,
  useCameraWb: true,
  highlight: 0, // 白飛びはクリップ（マゼンタ被りを出さない）
  userQual: 3, // AHD デモザイク
};

let ctor: Promise<typeof LibRawClass> | null = null;
function loadLibRaw() {
  // vite.config.ts の vendorLibraw が /vendor/libraw/ で配る（Worker と wasm の相対パスを保つため）
  ctor ??= import(/* @vite-ignore */ new URL('vendor/libraw/index.js', document.baseURI).href)
    .then((m) => m.default)
    .catch((e) => {
      ctor = null; // 次回やり直せるように
      throw new Error(`RAW 展開エンジン（LibRaw）を読み込めませんでした: ${e instanceof Error ? e.message : e}`);
    });
  return ctor;
}

function fmtShutter(s: number) {
  if (!s) return '';
  return s >= 0.3 ? `${+s.toFixed(1)}秒` : `1/${Math.round(1 / s)}秒`;
}

export async function decodeRaw(file: File): Promise<DecodedRaw> {
  const LibRaw = await loadLibRaw();
  const buf = new Uint8Array(await file.arrayBuffer());
  // LibRaw に渡すとバッファが Worker へ移って読めなくなるので、先にメタデータを読む
  const lens = readRw2LensMeta(buf);
  const t0 = performance.now();
  const raw = new LibRaw();
  try {
    await raw.open(buf, SETTINGS);
    const meta = (await raw.metadata()) as unknown as Record<string, unknown>;
    let thumb: Blob | null = null;
    try {
      const t = await raw.thumbnailData();
      if (t && t.format === 'jpeg') thumb = new Blob([t.data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
    } catch {
      thumb = null;
    }
    const img = await raw.imageData();
    if (!img || !(img.data instanceof Uint16Array) || img.colors !== 3) {
      throw new Error('16bit RGB として展開できませんでした');
    }
    const parts = [
      meta.iso_speed ? `ISO${meta.iso_speed}` : '',
      fmtShutter(Number(meta.shutter)),
      meta.aperture ? `F${+Number(meta.aperture).toFixed(1)}` : '',
      meta.focal_len ? `${Math.round(Number(meta.focal_len))}mm` : '',
    ].filter(Boolean);
    return {
      data: img.data,
      width: img.width,
      height: img.height,
      flip: Number(meta.flip) || 0,
      camera: `${meta.camera_make ?? ''} ${meta.camera_model ?? ''}`.trim(),
      exposure: parts as string[],
      thumb,
      lens: {
        ...lens,
        focal: lens.focal ?? (Number(meta.focal_len) || null),
        aperture: lens.aperture ?? (Number(meta.aperture) || null),
      },
      ms: performance.now() - t0,
    };
  } finally {
    raw.dispose();
  }
}
