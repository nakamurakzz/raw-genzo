// .cube（Adobe / Resolve 形式）の 3D LUT パーサと、内蔵のニュートラル LUT 生成

export interface Lut3D {
  size: number;
  /** R が最も速く変化する順で size^3 * 3 個 */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
}

export class CubeError extends Error {}

export function parseCube(text: string): Lut3D {
  let size = 0;
  let size1d = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let n = 0;

  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;
    const c0 = line.charCodeAt(0);
    const isNum = (c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 46 || c0 === 43;
    if (isNum) {
      if (size1d && !size) throw new CubeError('1D LUT には対応していません（3D LUT の .cube を使ってください）');
      if (size1d) throw new CubeError('1D シェーパー付きの .cube には対応していません');
      if (!data) throw new CubeError('LUT_3D_SIZE が見つかりません');
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new CubeError(`${li + 1} 行目の数値が3つありません`);
      if (n >= data.length) throw new CubeError('データ行が LUT_3D_SIZE より多すぎます');
      data[n++] = +parts[0];
      data[n++] = +parts[1];
      data[n++] = +parts[2];
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    switch (key.toUpperCase()) {
      case 'TITLE':
        title = line.slice(5).trim().replace(/^"|"$/g, '');
        break;
      case 'LUT_3D_SIZE':
        size = parseInt(rest[0], 10);
        if (!(size >= 2 && size <= 256)) throw new CubeError(`LUT_3D_SIZE が不正です: ${rest[0]}`);
        data = new Float32Array(size * size * size * 3);
        break;
      case 'LUT_1D_SIZE':
        size1d = parseInt(rest[0], 10);
        break;
      case 'DOMAIN_MIN':
        domainMin = [+rest[0], +rest[1], +rest[2]];
        break;
      case 'DOMAIN_MAX':
        domainMax = [+rest[0], +rest[1], +rest[2]];
        break;
      case 'LUT_3D_INPUT_RANGE':
        domainMin = [+rest[0], +rest[0], +rest[0]];
        domainMax = [+rest[1], +rest[1], +rest[1]];
        break;
      default:
        // LUT_1D_INPUT_RANGE やベンダー独自のキーは無視
        break;
    }
  }
  if (!data) throw new CubeError('LUT_3D_SIZE が見つかりません');
  if (n !== data.length) throw new CubeError(`データ行が足りません（${n / 3} / ${data.length / 3}）`);
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) throw new CubeError('DOMAIN_MIN / DOMAIN_MAX が不正です');
  }
  return { size, data, domainMin, domainMax, title };
}

/** 恒等 LUT。四面体補間は線形なので、2 格子でも入力をそのまま返す（＝厳密） */
export function makeIdentityLut(size = 2): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let n = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[n++] = r / (size - 1);
        data[n++] = g / (size - 1);
        data[n++] = b / (size - 1);
      }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'Identity' };
}
